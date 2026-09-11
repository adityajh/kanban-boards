import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DB, ssl:{rejectUnauthorized:false} });
await c.connect();
await c.query('truncate cards restart identity cascade');
const PRODUCT_LINES = [
 'Machine Weft — Single','Machine Weft — Double','Handtied Weft','Bulk Hair',
 'Closure (2×6 / 4×4 / 5×5)','Frontal (13×4 / 13×6)','Topper','Front Lace Wig',
 'Closure Wig','Full Lace Wig','I-Tip Keratin','Flat Tip Keratin','Regular Tape','Seamless Tape'
];
async function card(title, desc, status, assignee, tag, subs=[], links=[], notes=[]) {
  const { rows:[card] } = await c.query(
    'insert into cards (title,description,status,assignee,tag,position) values ($1,$2,$3,$4,$5,$6) returning id',
    [title, desc, status, assignee, tag, Date.now()+Math.random()]);
  let i=1;
  for (const s of subs) await c.query('insert into subtasks (card_id,title,position) values ($1,$2,$3)',[card.id,s,i++]);
  for (const l of links) await c.query('insert into links (card_id,label,url) values ($1,$2,$3)',[card.id,l.label,l.url]);
  for (const n of notes) await c.query('insert into notes (card_id,author,body) values ($1,$2,$3)',[card.id,n.author,n.body]);
  return card.id;
}

// PROJECT A — active
await card('Finalise the shade card',
  'A single visual reference of every Inditress colour, grouped as the factory groups them (Dark, Light, Ombre, Blend, Piano, Special). Each shade = swatch + code + name. Confirm swatches are real product photos.',
  'in_progress','Aadhya','A',
  ['Confirm full colour list with Deepak / factory','Source real swatch photos (not stock)','Group: Dark / Light / Ombre / Blend / Piano / Special','Lay out digital shade card','Adi review','Prep print-ready version'],
  [{label:'Product range (04-products.md)', url:'https://github.com'}],
  [{author:'Adi', body:'First priority alongside the one-pagers. Get the colour list locked with Deepak before designing.'}]);

await card('Create one-pagers for all product lines',
  'One clean one-pager per product line, same template across all so they read as a set. Template: name · category · honest description · who it\'s for · specs (sizes/textures/colours) · application method · why ours is trustworthy · photo.',
  'in_progress','Aadhya','A',
  ['Draft one-pager template (1 sample)','Get Adi sign-off on template', ...PRODUCT_LINES.map(p=>'One-pager: '+p), 'Consistency review pass'],
  [], [{author:'Adi', body:'Lock the template on one product first, then roll out the rest. 14 lines across 6 categories.'}]);

// PROJECT A — next
await card('Build the product map',
  'One-page "map of everything we make": Method/category × Textures × Sizes × Colours. A matrix or tree showing the full range at a glance.',
  'todo','Aadhya','A',
  ['Map the 6 categories & sub-lines','Add textures (natural vs artificial)','Add size range 4"–32"','Link to shade card','Adi review'], [], []);

// PROJECT B
await card('Map the post-CRM sales journey',
  'Document the journey from "lead lands in CRM" → "first order placed", stage by stage. For each stage: trigger, owner, customer experience, collateral needed. Anchor to Aida (primary) & Andrea (secondary).',
  'todo','Aadhya','B',
  ['Lead lands / first-touch','Qualify (real stylist vs price-shopper)','First contact + brand intro','Samples kit & follow-up','Evaluation (prove quality / ITS™)','First order / proposal / terms','Handover to relationship'], [], []);

await card('Build the collateral inventory',
  'From the journey map, list every collateral the team needs, who uses it, and status (build vs already-exists). Then brief the top 2–3 missing pieces.',
  'todo','Aadhya','B',
  ['List all collateral per journey stage','Assign owner to each','Tag build vs exists','Prioritise gaps','Write briefs for top 2–3 missing'], [], []);

// ONBOARDING
await card('Soak in the brand','Read Brand Guide, voice doc & the Chain of Trust narrative end-to-end. Return with questions.','todo','Aadhya','Onboarding',['Read brand guide','Read voice doc (19)','Read ITS™ standard (20)','List questions for Adi'],[],[]);
await card('Audit what\'s live','Walk the website template & current socials. Note what\'s on-brand, off-brand, missing.','todo','Aadhya','Onboarding',['Audit website template','Audit current socials','Write on/off-brand notes'],[],[]);
await card('Build the content engine','Draft a first monthly content calendar — founder story, transparency, stylist & product posts.','todo','Aadhya','Onboarding',['Draft monthly calendar','Cover founder / transparency / stylist / product','Adi review'],[],[]);
await card('Shape the visuals','Pull a shot-list & moodboard from the photography brief for the first content batch.','todo','Aadhya','Onboarding',['Read photography brief','Build shot-list','Build moodboard'],[],[]);

const { rows } = await c.query('select status, count(*) from cards group by status');
console.log('seeded:', rows.map(r=>r.status+':'+r.count).join('  '));
const { rows:[t] } = await c.query('select count(*) c from subtasks');
console.log('subtasks:', t.c);
await c.end();
