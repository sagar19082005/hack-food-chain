(async ()=>{
  const place = process.argv[2] || 'Bengaluru, Karnataka';
  const base = 'http://localhost:3004';
  const fetch = global.fetch || (await import('node-fetch')).default;
  function parseSections(text=''){
    const sections = {};
    const labels=['Description','Top attractions','Best time to visit','Food to try','AI Action Plan','Supply risk','Climate & Crop Factors'];
    for(const label of labels){
      const re=new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+ '[:\-]?\\s*([\\s\\S]*?)(?=\\n\\s*[A-Z][a-z]+[:\\-]|$)','i');
      const m=text.match(re);
      if(m) sections[label]=m[1].trim();
    }
    if(!Object.keys(sections).length){
      const parts=text.split(/\n\n+/).map(s=>s.trim()).filter(Boolean);
      if(parts.length) sections['Description']=parts[0];
      if(parts.length>1) sections['Top attractions']=parts[1];
    }
    return sections;
  }

  function computeSupplyRisk({weather,nasa}={}){
    try{
      let totalPrecip=0, days=0, avgTemp=null;
      if(nasa && nasa.properties && nasa.properties.parameter){
        const parameters=nasa.properties.parameter||{};
        const prec=parameters.PRECTOT||parameters.PRECTOTCORR||{};
        const t2m=parameters.T2M||{};
        const vals=Object.values(prec).map(v=>parseFloat(v)).filter(v=>!isNaN(v) && v>-900);
        days=vals.length; totalPrecip=vals.reduce((s,v)=>s+v,0);
        const temps=Object.values(t2m).map(v=>parseFloat(v)).filter(v=>!isNaN(v) && v>-900);
        if(temps.length) avgTemp=temps.reduce((s,v)=>s+v,0)/temps.length;
      }
      let score=30;
      if(days){ const precipPerDay=totalPrecip/Math.max(1,days); const precipPenalty=Math.max(0,Math.min(40,Math.round((40-precipPerDay)))); score+=precipPenalty; }
      if(avgTemp!==null){ if(avgTemp>30) score+=12; if(avgTemp>35) score+=8; }
      if(weather && weather.current && weather.current.weather && weather.current.weather[0]){
        const w=(weather.current.weather[0].main||'').toLowerCase(); if(w.includes('rain')||w.includes('thunderstorm')) score+=6; if(w.includes('extreme')||w.includes('storm')) score+=8;
      }
      score=Math.min(98,Math.max(5,Math.round(score)));
      const level= score>=70?'High':score>=40?'Medium':'Low';
      const reasons=[]; if(days && totalPrecip<60) reasons.push(`Low recent rainfall (${Math.round(totalPrecip)} mm)`); if(avgTemp!==null && avgTemp>30) reasons.push(`High avg temp (${Math.round(avgTemp)}°C)`); if(!reasons.length) reasons.push('Derived from recent climate data');
      return {level,pct:`${score}%`,reason:reasons.join('; '),totalPrecip,avgTemp,days};
    }catch(e){return {level:'Unknown',pct:'N/A',reason:'Insufficient data'}}
  }

  try{
    console.log('Geocoding',place);
    const gRes=await fetch(`${base}/api/geocode?place=${encodeURIComponent(place)}`);
    const geo = gRes.ok? await gRes.json() : null;
    console.log('geo',geo);

    let weather=null, nasa=null;
    if(geo){
      try{ console.log('Fetching NASA POWER'); const end=new Date(); const start=new Date(end.getTime()-29*24*60*60*1000); const fmt=d=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; const startStr=fmt(start), endStr=fmt(end); const nRes=await fetch(`${base}/api/nasa-power?lat=${geo.lat}&lon=${geo.lon}&start=${startStr}&end=${endStr}`); nasa = nRes.ok? await nRes.json() : null; console.log('nasa ok', !!nasa); }catch(e){console.warn('nasa err',e)}
      try{ console.log('Fetching OpenWeather'); const wRes=await fetch(`${base}/api/weather?lat=${geo.lat}&lon=${geo.lon}`); weather = (wRes.ok)? await wRes.json() : null; console.log('weather ok', !!weather);}catch(e){console.warn('weather err',e)}
    }

    const supplyObj = computeSupplyRisk({weather,nasa});
    console.log('Derived supplyObj',supplyObj);

    // build verification prompt
    let sensorSummary='';
    if(nasa){ const parameters=nasa.properties.parameter||{}; const prec=parameters.PRECTOT||parameters.PRECTOTCORR||{}; const t2m=parameters.T2M||{}; const days=Object.keys(prec).length || 0; const totalPrecip=Object.values(prec).map(v=>parseFloat(v)).filter(v=>!isNaN(v)&&v>-900).reduce((s,v)=>s+v,0); const temps=Object.values(t2m).map(v=>parseFloat(v)).filter(v=>!isNaN(v)&&v>-900); const avgTemp= temps.length? temps.reduce((s,v)=>s+v,0)/temps.length : null; sensorSummary=`days=${days},total_precip_mm=${Math.round(totalPrecip)},avg_temp_c=${avgTemp?Math.round(avgTemp):'N/A'}`; }
    else if(weather && weather.main){ sensorSummary=`temp_c=${Math.round(weather.main.temp||0)},conditions=${(weather.weather&&weather.weather[0]&&weather.weather[0].main)||''}`; }

    // wait 2s
    await new Promise(r=>setTimeout(r,2000));

    const verifyPrompt = sensorSummary? `Give short labeled sections (Description, AI Action Plan, Supply risk, Climate & Crop Factors) for ${place}.\nSensorData: ${sensorSummary}\nPlease verify and adjust.` : `Give short labeled sections for ${place}.`;
    console.log('Sending verify prompt to /api/gemini');
    let aiText='';
    try{
      const g = await fetch(`${base}/api/gemini`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({prompt:verifyPrompt, max_output_tokens:400})});
      if(g.ok){ const data = await g.json(); // attempt to extract text
        if(data.candidates && data.candidates.length) aiText = data.candidates.map(c=>c.content||c.output||'').join('\n\n');
        else if(data.output && typeof data.output==='string') aiText = data.output;
        else aiText = JSON.stringify(data);
      } else { const txt = await g.text().catch(()=>''); console.warn('gemini non-ok',g.status,txt); }
    }catch(e){ console.warn('gemini call failed',e); }

    console.log('AI text length', aiText.length);
    const sections = parseSections(aiText||'');

    // ensure supply risk in sections
    if(!sections['Supply risk'] || !/\d{1,3}%/.test(sections['Supply risk'])){
      sections['Supply risk'] = `${supplyObj.level} (${supplyObj.pct}) — ${supplyObj.reason}`;
    }

    // merge measured values into Climate & Crop Factors
    if(nasa){ const parameters=nasa.properties.parameter||{}; const prec=parameters.PRECTOT||parameters.PRECTOTCORR||{}; const t2m=parameters.T2M||{}; const days=Object.keys(prec).length||0; const totalPrecip=Object.values(prec).map(v=>parseFloat(v)).filter(v=>!isNaN(v)&&v>-900).reduce((s,v)=>s+v,0); const avgTemp = Object.values(t2m).map(v=>parseFloat(v)).filter(v=>!isNaN(v)&&v>-900).reduce((s,v)=>s+v,0)/Math.max(1,Object.values(t2m).length);
      const droughtText = `Rainfall last ${days} days: ${Math.round(totalPrecip)} mm.`;
      const tempText = `Average temperature last ${days} days: ${Math.round(avgTemp)}°C.`;
      const existing = sections['Climate & Crop Factors'] || '';
      let newClimate = existing.replace(/Drought:[^\n]*/i, `Drought: ${droughtText}`)
                               .replace(/Temp Rise:[^\n]*/i, `Temp Rise: ${tempText}`);
      if(!/Drought:/i.test(newClimate)) newClimate += `\nDrought: ${droughtText}`;
      if(!/Temp Rise:/i.test(newClimate)) newClimate += `\nTemp Rise: ${tempText}`;
      sections['Climate & Crop Factors'] = newClimate.trim();
    }

    console.log('\n=== FINAL SECTIONS ===');
    console.log(JSON.stringify(sections, null, 2));
    console.log('\n=== SUPPLY OBJ ===');
    console.log(JSON.stringify(supplyObj, null, 2));
    if(weather) console.log('\n=== CURRENT WEATHER ===', JSON.stringify({temp:weather.main.temp, cond: weather.weather && weather.weather[0] && weather.weather[0].description}, null,2));
  }catch(e){ console.error('run error',e) }
})();
