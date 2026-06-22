import { readFileSync } from 'node:fs';
const popcount = (b64) => { const buf = Buffer.from(b64||'', 'base64'); let c=0; for (const byte of buf){let v=byte;while(v){v&=v-1;c++;}} return c; };
for (const f of ['minimap','canyon.minimap','stanton.minimap','meemaw.minimap','xq.minimap']) {
  let j; try { j = JSON.parse(readFileSync(`public/da-hilg/${f}.json`,'utf8')); } catch { console.log(f,'MISSING'); continue; }
  const keys = ['fillRoad','fillDrive','fillWalk','fillCurb','fillLine','fillWater'];
  const cells = Object.fromEntries(keys.map(k => [k.replace('fill','').toLowerCase(), popcount(j[k])]));
  console.log(`${f.padEnd(16)} fillN=${j.fillN} whe=${j.worldHalfExtent} bounds=${j.bounds?`${j.bounds.minX},${j.bounds.minZ}..${j.bounds.maxX},${j.bounds.maxZ}`:'?'}`);
  console.log(`   cells:`, cells, 'creekSegs=', j.layers?.creek?.length||0);
}
