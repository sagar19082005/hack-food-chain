// Select the element with the ID 'next-page'
const nextPage = document.querySelector("#next-page");

// Check if the element exists before adding the listener
if (nextPage) {
    nextPage.addEventListener("click", function() {
        // Redirects the user to bindex.html
        console.log("hey");
        window.location.href = "bindex.html";
    });
} else {
    console.debug("#next-page not present (expected on other page)");
}

// --- Gemini-powered search and UI mapping ---
(function () {
    // Configuration
    // Use local proxy endpoint to avoid CORS and hide API key server-side
    const ENDPOINT = '/api/gemini';

    // Selectors for existing UI elements (do not create new elements)
    const searchInput = document.querySelector('.location-search');
    const searchIcon = document.querySelector('.search-icon');

    // Map content to existing elements in the UI
    // Keep `.ai-header` intact (it contains the robot icon and title). Do NOT overwrite it.
    const placeHeading = null; // reserved - don't overwrite existing header markup
    // Prefer a dedicated description paragraph inside the AI card; create it at runtime if missing
    let descriptionEl = document.querySelector('.ai-inner .ai-description');
    // Try multiple fallbacks for the attractions/action list to avoid missing selector errors
    const attractionsList = document.querySelector('.action-list') || document.querySelector('.ai-inner ul.fas.fa-robo') || document.querySelector('.viz-area .c-desc') || null; // attractions -> list
    const bestTimeEl = document.querySelector('.top-info'); // best time -> top-info area
    // pick a card-footer element to hold 'food' info (use second .card-footer if present)
    const cardFooters = document.querySelectorAll('.card-footer');
    const foodEl = cardFooters && cardFooters.length > 1 ? cardFooters[1] : cardFooters[0] || null;

    // Helper: show simple messages in the description area
    function showMessage(msg) {
        if (descriptionEl) descriptionEl.innerText = msg;
    }

    // Track whether we've already warned about Gemini issues to avoid console spam
    let _geminiErrorWarned = false;

    // Leaflet map handle
    let map = null;
    let mapMarker = null;
    function initMap(lat = 12.97, lon = 77.59) {
        try {
            if (!window.L) return;
            if (!map) {
                map = L.map('map').setView([lat, lon], 8);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '© OpenStreetMap'
                }).addTo(map);
            } else {
                map.setView([lat, lon], 8);
            }
            if (mapMarker) map.removeLayer(mapMarker);
            mapMarker = L.marker([lat, lon]).addTo(map);
        } catch (e) { console.warn('Leaflet map init failed', e); }
    }

    // Parse structured text returned by the model into sections
    function parseSections(text) {
        const sections = {};
        const labels = [
            'Description',
            'Top attractions',
            'Best time to visit',
            'Food to try',
            'AI Action Plan',
            'Supply risk',
            'Climate & Crop Factors'
        ];

        for (const label of labels) {
            const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[:\-]?\\s*([\\s\\S]*?)(?=\\n\\s*[A-Z][a-z]+[:\\-]|$)', 'i');
            const m = text.match(re);
            if (m) sections[label] = m[1].trim();
        }

        // Fallbacks: if no explicit labels, try to split by double newlines
        if (!Object.keys(sections).length) {
            const parts = text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
            if (parts.length) sections['Description'] = parts[0];
            if (parts.length > 1) sections['Top attractions'] = parts[1];
            if (parts.length > 2) sections['Best time to visit'] = parts[2];
            if (parts.length > 3) sections['Food to try'] = parts[3];
        }

        return sections;
    }

    // Parse supply risk like: "High (82%)" or "Supply risk: High - 82%"
    function parseSupplyRisk(text) {
        if (!text) return null;
        const mPct = text.match(/(\d{1,3})\s*%/);
        const mLevel = text.match(/\b(High|Medium|Low)\b/i);
        return {
            level: mLevel ? (mLevel[1].charAt(0).toUpperCase() + mLevel[1].slice(1).toLowerCase()) : null,
            pct: mPct ? `${mPct[1]}%` : null,
            raw: text
        };
    }

    // Parse climate block into specific factors
    function parseClimateFactors(text) {
        const out = {};
        if (!text) return out;
        const keys = ['Drought', 'Flood', 'Temp Rise', 'Crop Status'];
        for (const key of keys) {
            const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[:\-]?\\s*([\\s\\S]*?)(?=\\n\\s*[A-Z][a-z ]+[:\\-]|$)', 'i');
            const m = text.match(re);
            if (m) out[key] = m[1].trim();
        }
        // fallback: attempt to extract lines like 'Drought: ...' anywhere
        const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
            const parts = line.split(/[:\-]\s*/);
            if (parts.length >= 2) {
                const k = parts[0].trim();
                const v = parts.slice(1).join(': ').trim();
                if (keys.includes(k)) out[k] = v;
            }
        }
        return out;
    }

    // Derive a simple supply risk score from sensor data when the model omits a numeric percent
    function computeSupplyRisk({weather, nasa} = {}) {
        try {
            let totalPrecip = 0;
            let days = 0;
            let avgTemp = null;
            if (nasa && nasa.properties && nasa.properties.parameter) {
                const parameters = nasa.properties.parameter || {};
                const prec = parameters.PRECTOT || {};
                const t2m = parameters.T2M || {};
                days = Object.keys(prec || {}).length;
                totalPrecip = Object.values(prec || {}).reduce((s, v) => s + (parseFloat(v) || 0), 0);
                const temps = Object.values(t2m || {}).map(v => parseFloat(v) || 0).filter(v => !isNaN(v));
                if (temps.length) avgTemp = temps.reduce((s, v) => s + v, 0) / temps.length;
            }

            // base score and adjustments (very conservative/simple heuristic)
            let score = 30;
            if (days) {
                // less total precipitation increases risk (scale capped)
                const precipPerDay = totalPrecip / Math.max(1, days);
                const precipPenalty = Math.max(0, Math.min(40, Math.round((40 - precipPerDay) / 1)));
                score += precipPenalty;
            }
            if (avgTemp !== null) {
                if (avgTemp > 30) score += 12;
                if (avgTemp > 35) score += 8;
            }
            // brief look at OpenWeather current condition if available
            try {
                if (weather && weather.current && weather.current.weather && weather.current.weather[0]) {
                    const w = (weather.current.weather[0].main || '').toLowerCase();
                    if (w.includes('rain') || w.includes('thunderstorm')) score += 6;
                    if (w.includes('extreme') || w.includes('storm')) score += 8;
                }
            } catch (e) {}

            score = Math.min(98, Math.max(5, Math.round(score)));
            const level = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
            const reasons = [];
            if (days && totalPrecip < 60) reasons.push(`Low recent rainfall (${Math.round(totalPrecip)} mm)`);
            if (avgTemp !== null && avgTemp > 30) reasons.push(`High avg temp (${Math.round(avgTemp)}°C)`);
            if (!reasons.length) reasons.push('Derived from recent climate data');
            return { level, pct: `${score}%`, reason: reasons.join('; ') };
        } catch (e) {
            return { level: 'Unknown', pct: 'N/A', reason: 'Insufficient sensor data' };
        }
    }

    // Helper: render text into pointwise bullets inside a container
    function renderAsPoints(container, text) {
        if (!container) return;
        if (!text) {
            container.innerHTML = '<p class="chart-note">No data available.</p>';
            return;
        }
        // Normalize separators and split into short points
        const parts = String(text)
            .replace(/\u2022|\u2023|\u25E6/g, '\n')
            .split(/\n+|\.|;|\u2013|\u2014|\-|\u2027/) // split on newlines, periods, semicolons, dashes
            .map(s => s.trim())
            .filter(Boolean);

        if (!parts.length) {
            container.textContent = text;
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'chart-points';
        parts.forEach(p => {
            const li = document.createElement('li');
            li.textContent = p;
            ul.appendChild(li);
        });
        // Replace container contents
        container.innerHTML = '';
        container.appendChild(ul);
    }

    // Update UI based on parsed sections (keeps mapping logic in one place)
    function updateUI(sections, text) {
        console.log('updateUI called with sections:', sections);
        console.log('raw text preview:', (text||'').slice(0,200));
        // Update Description: ensure a dedicated `.ai-description` element exists inside `.ai-inner`
        try {
            const aiInner = document.querySelector('.ai-inner');
            if (!descriptionEl && aiInner) {
                descriptionEl = document.createElement('p');
                descriptionEl.className = 'ai-description';
                descriptionEl.style.margin = '8px 0 12px 0';
                descriptionEl.style.fontSize = '13px';
                descriptionEl.style.color = '#234';
                // insert description before the action list if present, otherwise append
                const actionList = aiInner.querySelector('ul.fas.fa-robo');
                if (actionList) aiInner.insertBefore(descriptionEl, actionList);
                else aiInner.appendChild(descriptionEl);
            }
            if (descriptionEl) descriptionEl.innerText = sections['Description'] || (text || '').split('\n\n')[0] || 'No description available.';
        } catch (e) { console.warn('Failed to set description element', e); }

        // Update AI Action Plan / Attractions using existing list items only (do NOT create new elements)
        if (attractionsList) {
            console.log('Updating attractionsList');
            const liNodes = attractionsList.querySelectorAll('li');
            const raw = sections['AI Action Plan'] || sections['Top attractions'] || '';
            const items = raw.split(/\n|\r|\u2022|\u2023|\u25E6|;|,|\u2027/).map(s => s.replace(/^[-\s\d\.\*]+/, '').trim()).filter(Boolean);
            if (liNodes.length) {
                for (let i = 0; i < liNodes.length; i++) {
                    if (i < items.length) liNodes[i].innerText = items[i];
                    else liNodes[i].innerText = '';
                }
                if (items.length > liNodes.length) {
                    const extra = items.slice(liNodes.length - 1).join('; ');
                    liNodes[liNodes.length - 1].innerText = extra;
                }
            } else {
                attractionsList.innerText = raw || 'No attractions available.';
            }
        } else console.warn('attractionsList not found');

        // Update Supply risk (level + percentage)
        const riskGauge = document.querySelector('.risk-gauge');
        const riskLevelEl = document.querySelector('.risk-high');
        const supplyRaw = sections['Supply risk'] || '';
        const supply = parseSupplyRisk(supplyRaw);
        if (supply) {
            console.log('Updating supply risk', supply);
            if (riskLevelEl && supply.level) riskLevelEl.innerText = supply.level;
            if (riskGauge && supply.pct) riskGauge.innerText = `~${supply.pct}`;
            // Update AI confidence footer to reflect food-supply risk percentage (or derive one)
            try {
                const confFooter = document.querySelector('.ai-inner .confidence-footer');
                if (confFooter) {
                    const derivePct = () => {
                        if (supply.pct) return supply.pct;
                        if (!supply.level) return null;
                        const lvl = supply.level.toLowerCase();
                        if (lvl === 'high') return '82%';
                        if (lvl === 'medium') return '50%';
                        if (lvl === 'low') return '18%';
                        return null;
                    };
                    const pctVal = derivePct() || 'N/A';
                    confFooter.innerHTML = `Prediction Confidence (food supply risk): <strong>${pctVal}</strong>`;
                }
            } catch (e) { console.warn('Failed to update confidence footer', e); }
        } else console.warn('supply parsing returned null');

        // Update Climate & Crop Factors (map to existing .c-card .c-desc elements)
        const climateRaw = sections['Climate & Crop Factors'] || '';
        const climateMap = parseClimateFactors(climateRaw);
        const cCards = document.querySelectorAll('.c-card');
        if (cCards && cCards.length) {
            console.log('Updating climate cards', cCards.length);
            cCards.forEach(card => {
                const titleEl = card.querySelector('.c-title h3');
                const descEl = card.querySelector('.c-desc');
                const chartBox = card.querySelector('.chart-box') || card.querySelector('.chat-box');
                if (!titleEl || !descEl) return;
                const key = titleEl.innerText.trim();
                // normalize key -> match climateMap keys
                const normKey = (key.toLowerCase().includes('temp') ? 'Temp Rise' : key);
                const candidate = climateMap[normKey] || (climateMap['Temp Rise'] && key.toLowerCase().includes('temp') ? climateMap['Temp Rise'] : climateMap[normKey]);
                if (candidate) {
                    console.log(`Setting ${key} =>`, candidate);
                    descEl.innerText = candidate;
                }

                // assign an id for this chat-box (done dynamically, no HTML changes)
                try {
                    const chatId = 'chat-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    card.id = chatId;
                } catch (e) {}

                // Generate a short prediction message for this factor and update the chart-box text
                const factorText = candidate || '';
                const msg = generateFactorMessage(key, factorText, (placeHeading && placeHeading.innerText) || 'the region');
                if (chartBox) renderAsPoints(chartBox, msg);
            });
        }

        // Fill AI summary and climate/ logistics spans
        try { fillAISummary(sections); } catch (e) { console.warn('fillAISummary failed', e); }
        try { fillClimateSpans(climateMap); } catch (e) { console.warn('fillClimateSpans failed', e); }
        try { fillLogisticsSpans(sections); } catch (e) { console.warn('fillLogisticsSpans failed', e); }

            // Adjust layout if content overflows: increase min-height and enable wrapping/scrolling
            try { adjustLayout(); } catch (e) { console.warn('adjustLayout failed', e); }


        function adjustLayout() {
            // Increase chart-box height and allow wrapping
            const chartBoxes = document.querySelectorAll('.chart-box, .chat-box');
            chartBoxes.forEach(cb => {
                cb.style.whiteSpace = 'normal';
                cb.style.wordBreak = 'break-word';
                cb.style.overflowY = 'auto';
                cb.style.maxHeight = '220px';
                cb.style.minHeight = '110px';
                cb.style.paddingRight = '8px';
            });

            // Viz area
            const viz = document.querySelector('.viz-area');
            if (viz) {
                viz.style.whiteSpace = 'normal';
                viz.style.wordBreak = 'break-word';
                viz.style.overflowY = 'auto';
                viz.style.maxHeight = '240px';
                viz.style.minHeight = '120px';
                viz.style.paddingRight = '8px';
            }

            // AI summary card: ensure spans wrap and are visible
            const aiCard = document.querySelector('.ai-glow-card .ai-inner');
            if (aiCard) {
                aiCard.style.whiteSpace = 'normal';
                aiCard.style.wordBreak = 'break-word';
                aiCard.style.minHeight = '120px';
            }
        }
        // Update Best time
        if (bestTimeEl) {
            bestTimeEl.innerText = sections['Best time to visit'] ? `Best time to visit: ${sections['Best time to visit']}` : bestTimeEl.innerText;
        }

        // Update Food
        if (foodEl) {
            foodEl.innerText = sections['Food to try'] ? `Food to try: ${sections['Food to try']}` : foodEl.innerText;
        }
    }

    // Fill AI summary spans (ul with class 'fas fa-robo') using sections or supply info
    function fillAISummary(sections) {
        const aiList = document.querySelector('ul.fas.fa-robo');
        if (!aiList) return;
        const spans = aiList.querySelectorAll('li span');
        // Map values: Risk type, Severity Level, Timeframe, Recommended Action, Affected Resource
        const supply = sections['Supply risk'] || '';
        const supplyParsed = parseSupplyRisk(supply) || {};
        const actionRaw = sections['AI Action Plan'] || '';
        const actions = actionRaw.split(/\n|;|\u2022/).map(s => s.replace(/^[-\s\d\.\*]+/, '').trim()).filter(Boolean);

        function short(s, n = 90) {
            if (!s) return '';
            const txt = String(s).trim();
            if (txt.length <= n) return txt;
            return txt.slice(0, n - 1).trim() + '…';
        }

        const values = [
            supplyParsed.level || 'Unknown',
            supplyParsed.pct || 'Unknown',
            sections['Best time to visit'] || 'N/A',
            actions[0] || 'N/A',
            sections['Description'] ? (sections['Description'].split('.')[0] || 'N/A') : 'N/A'
        ].map(v => short(v, 80));

        spans.forEach((sp, i) => {
            sp.innerText = values[i] || '';
            // ensure readable casing and wrapping
            sp.style.textTransform = 'none';
            sp.style.fontSize = '14px';
            sp.style.lineHeight = '1.3';
            sp.style.display = 'inline-block';
            sp.style.maxWidth = '60ch';
            sp.style.whiteSpace = 'normal';
        });
        // style the list to avoid big bullets and spacing issues
        aiList.style.listStyle = 'none';
        aiList.style.paddingLeft = '8px';
        aiList.style.margin = '6px 0';
    }

    // Populate chart-box lists for climate cards by filling their spans
    function fillClimateSpans(climateMap) {
        const cCards = document.querySelectorAll('.c-card');
        cCards.forEach(card => {
            const titleEl = card.querySelector('.c-title h3');
            const chartBox = card.querySelector('.chart-box');
            if (!titleEl || !chartBox) return;
            const key = titleEl.innerText.trim();
            const normKey = (key.toLowerCase().includes('temp') ? 'Temp Rise' : key);
            const data = climateMap[normKey] || '';

            // For each <li> span inside chartBox, try to set a concise value from data
            const lis = chartBox.querySelectorAll('li');
            lis.forEach(li => {
                const label = li.childNodes[0] && li.childNodes[0].textContent ? li.childNodes[0].textContent.trim() : '';
                const span = li.querySelector('span');
                if (!span) return;
                // heuristics
                if (/rainfall/i.test(label)) {
                    const m = (data || '').match(/(\d{1,3})\s*%/);
                    span.innerText = m ? `${m[1]}%` : (data || 'N/A');
                } else if (/soil moisture|moisture/i.test(label)) {
                    const m = (data || '').match(/(low|medium|high|\d{1,3}%)/i);
                    span.innerText = m ? m[1] : (data || 'N/A');
                } else if (/severity|risk/i.test(label)) {
                    const m = (data || '').match(/(low|medium|high|severe|minor|major)/i);
                    span.innerText = m ? (m[1][0].toUpperCase() + m[1].slice(1)) : (data || 'N/A');
                } else if (/water level|level/i.test(label)) {
                    const m = (data || '').match(/(\d+(?:\.\d+)?\s*m|rise|increase)/i);
                    span.innerText = m ? m[0] : (data || 'N/A');
                } else if (/temperature/i.test(label)) {
                    const m = (data || '').match(/(\+?\d{1,2}°?C|\d{1,2}°?)/i);
                    span.innerText = m ? m[0] : (data || 'N/A');
                } else if (/affected regions|zones/i.test(label)) {
                    const m = (data || '').match(/([A-Za-z\s,]+?(?=\.|$))/);
                    span.innerText = m ? m[0].trim() : (data || 'N/A');
                } else if (/crop|health|yield/i.test(label)) {
                    const m = (data || '').match(/(\d{1,3}\s*%)/);
                    span.innerText = m ? m[0] : (data || 'N/A');
                } else {
                    span.innerText = data || 'N/A';
                }
            });
        });
    }

    // Populate logistics viz spans in bottom-card (.viz-area .c-desc li span)
    function fillLogisticsSpans(sections) {
        const viz = document.querySelector('.viz-area ul.c-desc, .vix-box, .viz-area .vix-box');
        if (!viz) return;
        const spans = viz.querySelectorAll('li span');
        // Derive country from the search input and provide concise country-level info
        function getCountryFromInput() {
            const val = (searchInput && searchInput.value || '').trim();
            if (!val) return 'the country';
            const parts = val.split(',').map(s => s.trim()).filter(Boolean);
            let last = parts.length ? parts[parts.length - 1] : val;
            const low = last.toLowerCase();
            // Map some common Indian states/cities to India for better defaults
            const indiaKeys = ['karnataka','bengaluru','mumbai','maharashtra','tamil nadu','kerala','delhi','uttar pradesh','telangana','andhra'];
            if (indiaKeys.some(k => low.includes(k))) return 'India';
            // If last token looks like a country code (2-3 letters), return as upper
            if (last.length <= 3) return last.toUpperCase();
            return last;
        }

        const country = getCountryFromInput();
        const supplyRaw = sections['Supply risk'] || '';
        const supplyParsed = parseSupplyRisk(supplyRaw) || {};

        // Simple, generic country-level heuristics for the four viz items
        const importText = `${country}: Edible oils, Machinery`; // short list
        const exportText = `${country}: Rice, Spices`; 
        const priceText = supplyParsed.level === 'High' ? 'Prices: Rising ~5–10%' : 'Prices: Stable';
        const supplyText = supplyParsed.raw || sections['Supply risk'] || 'N/A';

        const values = [importText, exportText, priceText, supplyText];
        spans.forEach((sp, i) => sp.innerText = values[i] || 'N/A');
    }

        // Generate a concise prediction message for a climate factor
        function generateFactorMessage(factorName, factorText, place) {
            const lower = (factorText || '').toLowerCase();
            let severity = 'Unknown';
            if (/low|minor|decreasing|reduced/.test(lower)) severity = 'Low';
            if (/medium|moderate|stable/.test(lower)) severity = 'Medium';
            if (/high|severe|increasing|major|significant|extreme/.test(lower)) severity = 'High';

            let when = ''; // attempt to detect timing
            const whenMatch = factorText && factorText.match(/(next\s+\d+\s*(day|days|week|weeks|month|months|year|years))/i);
            if (whenMatch) when = ` Expected ${whenMatch[1]}.`;

            // Short messages per factor
            switch (factorName.toLowerCase()) {
                case 'drought':
                    return `Drought risk: ${severity}. ${factorText || ''}${when} Potential impact: reduced crop yields in ${place}.`;
                case 'flood':
                    return `Flood risk: ${severity}. ${factorText || ''}${when} Potential impact: supply chain and transport disruptions in ${place}.`;
                case 'temp rise':
                case 'temp':
                case 'temp rise':
                    return `Temperature trend: ${severity}. ${factorText || ''}${when} Potential impact: heat stress on crops in ${place}.`;
                case 'crop status':
                case 'crop':
                    return `Crop status: ${factorText || 'Information not available.'}`;
                default:
                    return `${factorName}: ${factorText || 'No data available.'}`;
            }
        }

    // Extract text from several response shapes
    function extractTextFromResponse(data) {
        try {
            if (!data) return '';
            if (data.candidates && data.candidates.length) {
                return data.candidates.map(c => c.content || c.output || '').join('\n\n').trim();
            }
            if (data.choices && data.choices.length) {
                return data.choices.map(c => c.text || c.message?.content || '').join('\n\n').trim();
            }
            if (data.output && typeof data.output === 'string') return data.output;
            // generic fallback: stringify any top-level text-like fields
            if (data.result && typeof data.result === 'string') return data.result;
            // Try common fields
            for (const key of ['text', 'content', 'message', 'reply']) {
                if (data[key] && typeof data[key] === 'string') return data[key];
            }
            return JSON.stringify(data);
        } catch (e) {
            return '';
        }
    }

    async function queryGemini(prompt) {
        const body = {
            prompt: prompt,
            max_output_tokens: 256
        };

        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        // If the proxy returned a non-OK status, allow caller to fallback gracefully
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            if (res.status === 404) {
                if (!_geminiErrorWarned) console.warn(`Gemini proxy not available (404). Response: ${errText}`);
                _geminiErrorWarned = true;
                return '';
            }
            if (!_geminiErrorWarned) console.warn(`Gemini API error ${res.status}: ${errText}`);
            _geminiErrorWarned = true;
            return '';
        }

        const data = await res.json().catch(() => null);
        // If server short-circuits with an error payload like { error: '...' }, treat as no-AI
        if (data && data.error) {
            if (!_geminiErrorWarned) console.warn('Gemini proxy response error:', data.error);
            _geminiErrorWarned = true;
            return '';
        }

        return extractTextFromResponse(data || {});
    }

    // Geocode a place via our server proxy (Nominatim)
    async function geocodePlace(place) {
        const res = await fetch(`/api/geocode?place=${encodeURIComponent(place)}`);
        if (!res.ok) {
            // return null so caller can continue; log for debugging
            const txt = await res.text().catch(()=>'');
            console.warn('Geocode returned non-OK:', res.status, txt);
            return null;
        }
        return res.json();
    }

    // Fetch current weather via server proxy (OpenWeather)
    async function getWeather(lat, lon) {
        const res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
        // Attempt to parse JSON even if response is not ok so server guidance is readable
        const payload = await res.json().catch(async () => {
            const txt = await res.text().catch(() => '');
            return { error: txt || 'Failed to parse weather response' };
        });
        if (payload && payload.error) {
            console.warn('OpenWeather proxy returned error:', payload);
            // don't throw — return null so caller can continue with mock/other data
            return null;
        }
        return payload;
    }

    // Fetch NASA POWER daily data for a date range via server proxy
    async function getNasaPower(lat, lon, start, end) {
        const res = await fetch(`/api/nasa-power?lat=${lat}&lon=${lon}&start=${start}&end=${end}`);
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`NASA POWER fetch failed: ${txt}`);
        }
        return res.json();
    }

    async function handleSearch() {
        const place = (searchInput && searchInput.value || '').trim();
        if (!place) {
            showMessage('Please enter a place');
            return;
        }

        // Show loading
        showMessage('Loading location data...');

        // Geocode and initialize map
        let coords = null;
        try {
            const geo = await geocodePlace(place);
            if (geo) {
                coords = { lat: geo.lat, lon: geo.lon, name: geo.display_name };
                initMap(coords.lat, coords.lon);
            } else {
                console.warn('Geocode did not return coordinates for', place);
            }
        } catch (e) {
            console.warn('Geocode failed', e);
            // continue — Gemini/sensor fallback will still work
        }

        // Prompt per requirements (also request AI plan, supply risk, and climate factors)
        const prompt = `Give short and clear details about ${place} including:\n- Description\n- Top attractions\n- Best time to visit\n- Food to try\nAlso provide:\n- AI Action Plan: 3 concise action bullets for supply chain or assistance\n- Supply risk: give level (High/Medium/Low) and percentage\n- Climate & Crop Factors: short status for Drought, Flood, Temp Rise, Crop Status\nKeep response structured and short.`;

        try {
            showMessage('Loading AI and sensor data...');

            // Fetch raw external data (if coords available)
            let weather = null;
            let nasa = null;
            let supplyObj = null;
            if (coords) {
                try {
                    weather = await getWeather(coords.lat, coords.lon);
                } catch (e) { console.warn('Weather fetch failed', e); }

                try {
                    // last 30 days
                    const end = new Date();
                    const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
                    const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
                    const startStr = fmt(start);
                    const endStr = fmt(end);
                    nasa = await getNasaPower(coords.lat, coords.lon, startStr, endStr);
                } catch (e) { console.warn('NASA POWER fetch failed', e); }
            }

            // Derive supply risk from available sensor data (may be used if AI does not provide a percent)
            try {
                supplyObj = computeSupplyRisk({ weather, nasa });
            } catch (e) { console.warn('computeSupplyRisk failed', e); }

            // Build sensor summary to include for verification
            let sensorSummary = '';
            try {
                if (nasa) {
                    const parameters = nasa?.properties?.parameter || {};
                    const prec = parameters.PRECTOT || {};
                    const t2m = parameters.T2M || {};
                    const days = Object.keys(prec || {}).length || 0;
                    const totalPrecip = Object.values(prec || {}).reduce((s,v)=>s+(parseFloat(v)||0),0);
                    const avgTemp = Object.values(t2m || {}).reduce((s,v)=>s+(parseFloat(v)||0),0) / Math.max(1,Object.values(t2m||{}).length || 1);
                    const heavy = Object.values(prec||{}).filter(v => parseFloat(v) > 50).length;
                    sensorSummary = `Sensor summary for ${place}: days=${days}, total_precip_mm=${Math.round(totalPrecip)}, avg_temp_c=${Math.round(avgTemp)}, heavy_precip_days=${heavy}.`;
                } else if (weather && weather.current) {
                    sensorSummary = `Weather summary for ${place}: temp_c=${Math.round(weather.current.temp || 0)}, conditions=${(weather.current.weather && weather.current.weather[0]&&weather.current.weather[0].main) || ''}.`;
                }
            } catch (e) { console.warn('Failed to build sensor summary', e); }

            // Wait briefly so sensors/APIs settle and to follow your requested pause
            await new Promise(r => setTimeout(r, 2000));

            // Query Gemini with sensor-augmented verification prompt (if available)
            let text = '';
            try {
                const verifyPrompt = sensorSummary ? `${prompt}\n\nSensorData: ${sensorSummary}\n\nPlease verify the sensor data and adjust any supply-risk percentage or climate statements if needed. Reply in short labeled sections: Description, AI Action Plan, Supply risk, Climate & Crop Factors.` : prompt;
                text = await queryGemini(verifyPrompt);
                if (!text) console.warn('No AI text returned; proceeding with sensor-derived sections');
            } catch (e) {
                console.warn('QueryGemini failed', e);
                text = '';
            }

            const sections = parseSections(text || '');

            // Merge measured numeric values into sections for accuracy (do not let model overwrite raw sensor numbers)
            try {
                if (nasa) {
                    const parameters = nasa?.properties?.parameter || {};
                    const prec = parameters.PRECTOT || {};
                    const t2m = parameters.T2M || {};
                    const days = Object.keys(prec || {}).length || 0;
                    const totalPrecip = Object.values(prec || {}).reduce((s,v)=>s+(parseFloat(v)||0),0);
                    const avgTemp = Object.values(t2m || {}).reduce((s,v)=>s+(parseFloat(v)||0),0) / Math.max(1,Object.values(t2m||{}).length || 1);
                    const droughtText = `Rainfall last ${days} days: ${Math.round(totalPrecip)} mm.`;
                    const tempText = `Average temperature last ${days} days: ${Math.round(avgTemp)}°C.`;
                    const existing = sections['Climate & Crop Factors'] || '';
                    // replace or append measured lines
                    const newClimate = existing.replace(/Drought:[^\n]*/i, `Drought: ${droughtText}`)
                                              .replace(/Temp Rise:[^\n]*/i, `Temp Rise: ${tempText}`);
                    sections['Climate & Crop Factors'] = newClimate.includes('Drought:') || newClimate.includes('Temp Rise:') ? newClimate : `${existing}\nDrought: ${droughtText}\nTemp Rise: ${tempText}`;
                }
            } catch (e) { console.warn('Failed to merge measured values', e); }

            // Augment climateMap with measured data
            if (nasa) {
                try {
                    // extract PRECTOT and T2M
                    const parameters = nasa?.properties?.parameter || {};
                    const prec = parameters.PRECTOT || {};
                    const t2m = parameters.T2M || {};
                    const days = Object.keys(prec || {}).length;
                    const totalPrecip = Object.values(prec || {}).reduce((s,v)=>s+(parseFloat(v)||0),0);
                    const avgTemp = Object.values(t2m || {}).reduce((s,v)=>s+(parseFloat(v)||0),0) / Math.max(1, Object.values(t2m||{}).length);

                    // create synthetic Climate & Crop Factors text for better UI mapping
                    const droughtText = `Rainfall last ${days} days: ${Math.round(totalPrecip)} mm. Estimated deficit vs typical: ${Math.max(0, Math.round((1 - (totalPrecip/100))*100))}%`;
                    const floodText = (Object.values(prec||{}).some(v=>parseFloat(v) > 50)) ? 'Recent heavy daily rainfall spikes detected; localized flood risk elevated.' : 'No extreme daily rainfall detected.';
                    const tempText = `Average temperature last ${days} days: ${Math.round(avgTemp)}°C. Recent warming trend may stress crops.`;
                    const cropText = `${totalPrecip < 60 ? 'Water stress likely' : 'Moisture conditions adequate'}.`;

                    sections['Climate & Crop Factors'] = `Drought: ${droughtText}\nFlood: ${floodText}\nTemp Rise: ${tempText}\nCrop Status: ${cropText}`;
                } catch (e) { console.warn('Failed to synthesize nasa data', e); }
            }

            // If the AI didn't provide a numeric supply risk, derive one from sensor data
            try {
                if (!sections['Supply risk'] || !/\d{1,3}\s*%/.test(sections['Supply risk'])) {
                    const sObj = supplyObj || computeSupplyRisk({ weather, nasa });
                    sections['Supply risk'] = `${sObj.level} (${sObj.pct}) — ${sObj.reason}`;
                }
            } catch (e) { console.warn('Failed to derive supply risk', e); }

            // If AI Action Plan is missing or too short, synthesize reasonable defaults from supply level
            try {
                const planRaw = (sections['AI Action Plan'] || '').trim();
                if (!planRaw || planRaw.length < 20) {
                    const sObj = supplyObj || computeSupplyRisk({ weather, nasa });
                    const level = (sObj && sObj.level) || 'Unknown';
                    let actions = [];
                    if (level === 'High') {
                        actions = [
                            'Increase emergency imports and buffer stocks for essential grains.',
                            'Prioritize irrigation and water-conservation measures locally.',
                            'Coordinate alternate logistics routes to avoid expected bottlenecks.'
                        ];
                    } else if (level === 'Medium') {
                        actions = [
                            'Monitor markets and maintain moderate buffer stocks.',
                            'Enhance monitoring of weather and crop conditions.',
                            'Strengthen local distribution to critical areas.'
                        ];
                    } else if (level === 'Low') {
                        actions = [
                            'Maintain normal stock rotations and monitoring.',
                            'Encourage routine irrigation and pest surveillance.',
                            'Prepare contingency plans in case of rapid weather changes.'
                        ];
                    } else {
                        actions = [
                            'Monitor sensor and market data for changes.',
                            'Collect additional local information to refine recommendations.',
                            'Prepare basic contingency measures as precaution.'
                        ];
                    }
                    sections['AI Action Plan'] = actions.join('\n');
                }
            } catch (e) { console.warn('Failed to synthesize AI Action Plan', e); }

            // Update UI with merged sections
            updateUI(sections, text);

            // mark todo step completed for parsing & mapping (best-effort local update)
            // (This does not call manage_todo_list again to avoid unnecessary tool calls.)
        } catch (err) {
            console.error(err);
            showMessage('Failed to load data');
            // --- Mock fallback for rapid testing ---
            console.warn('Applying mock data due to API failure');
            const mockText = `Description: A regional summary for ${place}.\n\nAI Action Plan:\n- Increase rice imports from nearby states to stabilize local prices.\n- Maintain 60-day buffer stock for essential grains.\n- Monitor and reroute logistics to avoid port delays in South India.\n\nSupply risk: High (82%)\n\nClimate & Crop Factors:\nDrought: Low rainfall in last 2 months\nFlood: Minor flood risk in low-lying areas\nTemp Rise: Above average temperatures predicted\nCrop Status: Yields affected by water stress\n\nTop attractions: Market district, Riverfront\nBest time to visit: October to February\nFood to try: Local rice dishes, street snacks`;
            const sections = parseSections(mockText);
            updateUI(sections, mockText);
        }
    }

    // Wire handlers: click on search icon and Enter key on input
    if (searchIcon) searchIcon.addEventListener('click', handleSearch);
    if (searchInput) {
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSearch();
            }
        });
    }

    // Reverse geocode helper (calls server /api/geocode with lat/lon)
    async function reverseGeocode(lat, lon) {
        try {
            const res = await fetch(`/api/geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { console.warn('reverseGeocode failed', e); return null; }
    }

    // On load: attempt browser geolocation and auto-search. Fallback to a single search using current input value.
    if (searchInput) {
        if (navigator.geolocation) {
            // Try to get a quick location; if it fails, fall back to a normal search
            navigator.geolocation.getCurrentPosition(async (pos) => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                try {
                    const geo = await reverseGeocode(lat, lon);
                    if (geo && geo.display_name) {
                        searchInput.value = geo.display_name;
                    } else {
                        // show coords if reverse lookup fails
                        searchInput.value = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
                    }
                } catch (e) { console.warn('reverse geocode attempt failed', e); }
                // Trigger search after geolocation/resolution
                handleSearch();
            }, (err) => {
                console.warn('Geolocation not available or denied', err);
                // fallback: run one search using any existing input
                setTimeout(() => handleSearch(), 400);
            }, { timeout: 5000, maximumAge: 60 * 1000 });
        } else {
            // no geolocation API; perform the normal initial search
            setTimeout(() => handleSearch(), 400);
        }
    }

})();