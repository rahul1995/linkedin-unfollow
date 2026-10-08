/* Simple LinkedIn connection walker.
   Load in a signed-in www.linkedin.com tab.
   No requests on load.

   Usage:
     await LISimple.run({ maxPeople: 40 })   // process up to 40, then stop
     LISimple.download()                     // save checkpoint
     LISimple.importCheckpoint(json)         // load checkpoint next day
     await LISimple.run({ maxPeople: 40 })   // continues from saved offset

   Extremely slow & simple on purpose.
*/
(() => {
  'use strict';
  if (location.hostname !== 'www.linkedin.com') throw Error('Use www.linkedin.com tab');

  // ── settings (edit if you want) ──────────────────────────────────────────
  const DELAY_MIN = 8000;   // 8 s
  const DELAY_MAX = 15000;  // 15 s
  const PAGE_SIZE = 40;     // connections per API page
  const BATCH_PAUSE = 5 * 60 * 1000; // 5 min rest after every page

  // ── state ────────────────────────────────────────────────────────────────
  let offset = 0;
  let done = 0;
  let unfollowed = 0;
  let stopped = false;
  let busy = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = () => DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));

  function csrf() {
    const v = document.cookie.split('; ').find(c => c.startsWith('JSESSIONID='));
    if (!v) throw Error('No CSRF cookie – sign in first');
    return v.slice(11).replace(/"/g, '');
  }

  async function api(path, body) {
    if (stopped) throw Error('Stopped');
    await sleep(jitter());
    const headers = { 'csrf-token': csrf() };
    if (body) headers['content-type'] = 'application/json';
    else if (path.startsWith('/voyager/')) {
      headers['x-restli-protocol-version'] = '2.0.0';
      headers['accept'] = 'application/vnd.linkedin.normalized+json+2.1';
    }
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if ([401, 403, 429, 999].includes(res.status)) {
      stopped = true;
      throw Error('Rate limit / block / auth error ' + res.status);
    }
    if (!res.ok) throw Error('HTTP ' + res.status);
    return res.text();
  }

  async function json(path) {
    return JSON.parse(await api(path));
  }

  // ── fetch one page of connections ────────────────────────────────────────
  async function fetchPage() {
    const q = new URLSearchParams({
      decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15',
      count: String(PAGE_SIZE),
      q: 'search',
      sortType: 'RECENTLY_ADDED',
      start: String(offset)
    });
    const j = await json('/voyager/api/relationships/dash/connections?' + q);
    const elements = j.data?.['*elements'] || j.data?.elements || [];
    const map = new Map((j.included || []).map(x => [x.entityUrn, x]));
    const list = [];
    for (const urn of elements) {
      const c = map.get(urn);
      const p = map.get(c?.connectedMember || c?.['*connectedMemberResolutionResult']);
      if (!p?.publicIdentifier || !p.entityUrn) continue;
      list.push({
        profileUrn: p.entityUrn,
        slug: p.publicIdentifier,
        name: [p.firstName, p.lastName].filter(Boolean).join(' '),
        memberId: null
      });
    }
    offset += elements.length;
    const total = j.data?.paging?.total;
    const ended = elements.length === 0 || (Number.isFinite(total) && offset >= total);
    return { list, ended };
  }

  // ── Robust collection helper ───────────────────
  function collection(map, ref) {
    const c = map.get(ref);
    if (!c) return [];
    const refs = c['*elements'] || [];
    return refs.map(r => map.get(r)).filter(Boolean);
  }

  // ── profile + classify (binary keep / candidate) ────────────────
  async function getProfile(c) {
    const q = new URLSearchParams({
      q: 'memberIdentity',
      memberIdentity: c.slug,
      decorationId: 'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101'
    });
    const j = await json('/voyager/api/identity/dash/profiles?' + q);
    const map = new Map((j.included || []).map(x => [x.entityUrn, x]));
    const p = map.get(c.profileUrn);
    if (!p) throw Error('Profile not found');

    const memberId = (p.objectUrn || '').match(/urn:li:member:(\d+)/)?.[1];
    if (!memberId) throw Error('No memberId');

    // Correct nested extraction
    const groups = collection(map, p['*profilePositionGroups']);
    const positions = groups.flatMap(g =>
      collection(map, g['*profilePositionInPositionGroup'])
    ).map(pos => ({
      company: (pos.companyName || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, ''),
      title:   (pos.title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, ''),
      current: !!(pos.dateRange?.start && !pos.dateRange?.end)
    }));

    const education = collection(map, p['*profileEducations']).map(e =>
      (e.schoolName || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    );

    const headline = (p.headline || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

    // Stronger keep rules (still only keep / candidate)
    const employer = /^(?:google|google india|google llc|google inc|microsoft|microsoft india|microsoft corporation|adobe|adobe systems|adobe india|meta|meta platforms|facebook|atlassian|salesforce|salesforce com|quillbot|quill bot|learneo)(?: (?:inc|incorporated|llc|ltd|limited|corporation|corp|pvt|private|india|systems|platforms|technologies|software))*$/;
    const nit = /\b(?:nit kurukshetra|nit kkr|nitkkr|national institute of (?:technology )?kurukshetra|regional engineering college kurukshetra|rec kurukshetra)\b/;
    const hrStrong = /\b(?:recruiter|recruiting|recruitment|talent acquisition|talent sourcing|talent sourcer|human resources|hrbp|hr business partner|people operations|people partner|people and culture|headhunter|headhunting|executive search|staffing consultant|staffing specialist|staffing manager|campus recruitment|university recruiting)\b/;
    const hrShort = /\bhr\b/;
    const technicalHR = /\b(?:software|developer|engineer|platform|product|hrms|hris|hr tech|hr technology)\b/;

    let decision = 'candidate';

    if (positions.some(pos => employer.test(pos.company))) decision = 'keep';
    if (positions.some(pos => pos.current && (hrStrong.test(pos.title) || hrShort.test(pos.title)) && !technicalHR.test(pos.title))) decision = 'keep';
    if (education.some(s => nit.test(s))) decision = 'keep';
    if ((hrStrong.test(headline) || hrShort.test(headline)) && !technicalHR.test(headline) && !/\b(?:former|previously|ex recruiter|ex hr|ex talent)\b/.test(headline)) {
      decision = 'keep';
    }

    return {
      memberId,
      decision,
      headline: p.headline || '',
      company: positions.find(p => p.current)?.company || positions[0]?.company || ''
    };
  }

  // ── unfollow ─────────────────────────────────────────────────────────────
  async function doUnfollow(memberId) {
    const REQUEST = 'com.linkedin.sdui.requests.mynetwork.addaUpdateFollowState';
    const body = {
      requestId: REQUEST,
      serverRequest: {
        requestId: REQUEST,
        requestedArguments: {
          '$type': 'proto.sdui.actions.requests.RequestedArguments',
          requestedStateKeys: [],
          payload: {
            followStateType: 'FollowStateType_UNFOLLOW',
            memberUrn: { memberId }
          },
          requestMetadata: { '$type': 'proto.sdui.common.RequestMetadata' }
        },
        isApfcEnabled: false,
        isStreaming: false,
        rumPageKey: ''
      },
      states: [],
      requestedArguments: {
        '$type': 'proto.sdui.actions.requests.RequestedArguments',
        requestedStateKeys: [],
        payload: {
          followStateType: 'FollowStateType_UNFOLLOW',
          memberUrn: { memberId }
        },
        requestMetadata: { '$type': 'proto.sdui.common.RequestMetadata' },
        states: [],
        screenId: '',
        knownTemplateIds: []
      }
    };
    await api('/flagship-web/rsc-action/actions/server-request?sduiid=' + REQUEST, body);
  }

  // ── main loop ────────────────────────────────────────────────────────────
  async function run({ maxPeople = 40 } = {}) {
    if (busy) throw Error('Already running');
    busy = true;
    stopped = false;
    let processed = 0;

    try {
      console.info(`Starting from offset ${offset}. Will process up to ${maxPeople} people.`);

      while (!stopped && processed < maxPeople) {
        const { list, ended } = await fetchPage();
        if (list.length === 0 || ended) {
          console.info('Reached end of connections.');
          break;
        }

        for (const c of list) {
          if (stopped || processed >= maxPeople) break;

          try {
            const info = await getProfile(c);
            c.memberId = info.memberId;

            if (info.decision === 'keep') {
              console.info(`KEEP  ${c.name} [${info.company}] (${info.headline})`);
            } else {
              // candidate → unfollow immediately
              await doUnfollow(info.memberId);
              unfollowed++;
              console.info(`UNFOLLOWED  ${c.name}`);
            }
          } catch (e) {
            console.warn(`ERROR  ${c.name}: ${e.message}`);
            if (stopped) break;
          }

          processed++;
          done++;
        }

        if (!stopped && processed < maxPeople) {
          console.info(`Page done. offset=${offset}  Pausing ${BATCH_PAUSE / 1000}s …`);
          await sleep(BATCH_PAUSE);
        }
      }

      console.info(`Session finished. processed=${processed}  totalDone=${done}  unfollowed=${unfollowed}  nextOffset=${offset}`);
      return { processed, done, unfollowed, offset };
    } finally {
      busy = false;
    }
  }

  // ── checkpoint ───────────────────────────────────────────────────────────
  function download() {
    const data = { offset, done, unfollowed, savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'linkedin-simple-checkpoint.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.info('Checkpoint downloaded', data);
  }

  function importCheckpoint(data) {
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    if (!Number.isInteger(obj.offset) || obj.offset < 0) throw Error('Bad checkpoint');
    offset = obj.offset;
    done = obj.done || 0;
    unfollowed = obj.unfollowed || 0;
    console.info('Checkpoint loaded', { offset, done, unfollowed });
  }

  function stop() { stopped = true; }

  function status() {
    return { offset, done, unfollowed, busy, stopped };
  }

  window.LISimple = { run, download, importCheckpoint, stop, status };

  console.info('LISimple loaded. Example: await LISimple.run({ maxPeople: 30 })');
})();