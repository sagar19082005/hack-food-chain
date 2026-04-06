(async ()=>{
  try{
    const place = 'Bengaluru, Karnataka';
    const geoRes = await fetch(`http://localhost:3004/api/geocode?place=${encodeURIComponent(place)}`);
    const geo = await geoRes.json();
    const lat = geo.lat, lon = geo.lon;
    const end = new Date();
    const start = new Date(end.getTime() - 29*24*60*60*1000);
    const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const startStr = fmt(start), endStr = fmt(end);
    const nasaRes = await fetch(`http://localhost:3004/api/nasa-power?lat=${lat}&lon=${lon}&start=${startStr}&end=${endStr}`);
    const nasa = await nasaRes.json();
    const params = nasa.properties.parameter;
    const precKey = Object.keys(params).find(k=>/PRECTOT/i.test(k)) || Object.keys(params)[0];
    const t2mKey = Object.keys(params).find(k=>/T2M/i.test(k));
    const prec = params[precKey] || {};
    const t2m = params[t2mKey] || {};
    // filter out fill values (POWER uses -999 for missing)
    const precVals = Object.values(prec).map(v=>parseFloat(v)).filter(v=>!isNaN(v) && v > -900);
    const t2mVals = Object.values(t2m).map(v=>parseFloat(v)).filter(v=>!isNaN(v) && v > -900);
    const days = precVals.length;
    const totalPrecip = precVals.reduce((s,v)=>s+v,0);
    const temps = t2mVals;
    const avgTemp = temps.length? temps.reduce((s,v)=>s+v,0)/temps.length : null;
    const heavy = precVals.filter(v=>v>50).length;
    console.log('place', geo.display_name);
    console.log('days', days, 'totalPrecip_mm', Math.round(totalPrecip*100)/100, 'avgTemp_C', avgTemp?Math.round(avgTemp*100)/100:'N/A', 'heavyDays', heavy);
    // derive score
    let score = 30;
    if (days){
      const precipPerDay = totalPrecip / days;
      const precipPenalty = Math.max(0, Math.min(40, Math.round((40 - precipPerDay))));
      score += precipPenalty;
    }
    if (avgTemp !== null){ if (avgTemp>30) score+=12; if (avgTemp>35) score+=8; }
    if (heavy>0) score+=6;
    score = Math.min(98, Math.max(5, Math.round(score)));
    const level = score>=70?'High':score>=40?'Medium':'Low';
    console.log('Derived supply risk:', level, `(${score}%)`);
  }catch(e){console.error(e)}
})();
