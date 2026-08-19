#!/usr/bin/env node
// sc.js — si-coder provider console.
//
//   sc setup        [--providers a,b | --target t]   interactive wizard for what is missing
//   sc providers    [show|set|rm <id>]               inspect / rotate / remove one provider
//   sc doctor       [--providers a,b | --target t]   LIVE verification against each real API
//   sc preflight    --target <t>                     what /sc-all runs before deploying
//
// The split that matters: `providers` reports what is CONFIGURED (presence + format),
// `doctor` reports what actually WORKS (a real call to the real API). A token can be
// perfectly well-formed and still be revoked, expired, or belong to the wrong account —
// only the second question catches that, and it is the one that used to go unasked.
const path = require('path');
const {
  PROVIDERS, TARGET_PROVIDERS, VALIDATORS, DOMAIN_VARS,
} = require(path.resolve(__dirname, '../lib/providers'));
const { isSecret, sourceLine, readShellRcEnv } =
  require(path.resolve(__dirname, '../skills/sc-onboarding/lib/onboarding-domains'));
const { appendExportToShellRc, removeExportsFromShellRc, scanProcessEnv } =
  require(path.resolve(__dirname, '../lib/env'));
const { askVisible, askHidden, redactValue, isInteractive, confirm, selectOne, selectMany } =
  require(path.resolve(__dirname, '../lib/prompt'));

const byId = new Map(PROVIDERS.map(p => [p.id, p]));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// process.env wins over ~/.bashrc: a value exported in the current shell is what the
// sc-* scripts will actually see, regardless of what the file says.
function currentEnv() {
  const rc = readShellRcEnv();
  const merged = { ...rc };
  for (const [k, v] of Object.entries(process.env)) if (v) merged[k] = v;
  return merged;
}

function sourceOf(key) {
  if (process.env[key]) return 'shell';
  if (readShellRcEnv()[key]) return '.bashrc';
  return '—';
}

function resolveIds(args) {
  if (args.target) {
    const ids = TARGET_PROVIDERS[args.target];
    if (!ids) die(`unknown --target "${args.target}" (expected: ${Object.keys(TARGET_PROVIDERS).join(' | ')})`);
    return ids;
  }
  if (typeof args.providers === 'string') {
    const ids = args.providers.split(',').map(s => s.trim()).filter(Boolean);
    const bad = ids.filter(i => !byId.has(i));
    if (bad.length) die(`unknown provider(s): ${bad.join(', ')}`);
    return ids;
  }
  return null;
}

function die(msg, code = 1) { console.error(`❌ ${msg}`); process.exit(code); }

// ---------------------------------------------------------------------------
// providers — what is configured
// ---------------------------------------------------------------------------
function varState(v, env) {
  if (!env[v.key]) return v.required ? 'MISSING' : 'unset';
  const validator = VALIDATORS[v.key];
  if (validator && !validator(env[v.key])) return 'INVALID';
  return 'set';
}

function cmdProvidersList(args) {
  const env = currentEnv();
  const ids = resolveIds(args) || PROVIDERS.map(p => p.id);
  console.log('\n🔌 providers\n');
  for (const id of ids) {
    const p = byId.get(id);
    const states = p.vars.map(v => varState(v, env));
    const missing = p.vars.filter((v, i) => states[i] === 'MISSING').map(v => v.key);
    const invalid = p.vars.filter((v, i) => states[i] === 'INVALID').map(v => v.key);
    const setCount = states.filter(s => s === 'set').length;
    let mark = '✅';
    if (invalid.length) mark = '❗';
    else if (missing.length) mark = '❌';
    else if (setCount === 0) mark = '⚪';
    const tag = p.status === 'stub' ? ' (stub)' : '';
    console.log(`  ${mark} ${p.id.padEnd(14)} ${String(setCount).padStart(2)}/${p.vars.length} set${tag}  — ${p.blurb}`);
    if (missing.length) console.log(`       missing required: ${missing.join(', ')}`);
    if (invalid.length) console.log(`       failed validation: ${invalid.join(', ')}`);
  }
  console.log('\n  ✅ complete   ❌ missing required   ❗ present but malformed   ⚪ nothing set\n');
  console.log('  sc providers show <id>   sc providers set <id>   sc doctor\n');
}

async function cmdProvidersShow(id) {
  if (!id) id = await pickProvider('Show which provider?');
  const p = byId.get(id) || die(`unknown provider "${id}"`);
  const env = currentEnv();
  console.log(`\n🔌 ${p.id} — ${p.title}${p.status === 'stub' ? '  (STUB: script not implemented)' : ''}`);
  console.log(`   ${p.blurb}\n`);
  for (const v of p.vars) {
    const st = varState(v, env);
    const icon = { set: '✅', MISSING: '❌', INVALID: '❗', unset: '⚪' }[st];
    console.log(`  ${icon} ${v.key}${v.required ? ' (required)' : ''}`);
    if (env[v.key]) console.log(`       value : ${isSecret(v.key) ? redactValue(env[v.key]) : env[v.key]}   [from ${sourceOf(v.key)}]`);
    const src = sourceLine(v.key);
    if (src) console.log(`       ↳ ${src}`);
  }
  console.log('');
}


// A provider list shaped for the arrow-key pickers, annotated with live state so the user
// can see what needs attention without leaving the menu.
function providerItems() {
  const env = currentEnv();
  return PROVIDERS.map(p => {
    const states = p.vars.map(v => varState(v, env));
    const missing = states.filter(s => s === 'MISSING').length;
    const invalid = states.filter(s => s === 'INVALID').length;
    const set = states.filter(s => s === 'set').length;
    let mark = '✅';
    if (invalid) mark = '❗';
    else if (missing) mark = '❌';
    else if (!set) mark = '⚪';
    return {
      id: p.id,
      label: `${mark} ${p.id.padEnd(14)} ${String(set).padStart(2)}/${p.vars.length}`,
      hint: `${p.status === 'stub' ? '(stub) ' : ''}${p.blurb}`,
      needsAttention: missing > 0 || invalid > 0,
    };
  });
}

// Pick one provider by arrow keys when the id was not given on the command line.
async function pickProvider(title) {
  if (!isInteractive()) die('provider id required on a non-TTY, e.g. `sc providers show cf`');
  const id = await selectOne(title, providerItems());
  if (!id) { console.log('cancelled'); process.exit(0); }
  return id;
}

// ---------------------------------------------------------------------------
// setup / set — collect values
// ---------------------------------------------------------------------------
async function promptForVar(v, { force = false } = {}) {
  const src = sourceLine(v.key);
  console.log('');
  console.log(`  ${v.key}${v.required ? '' : '  (optional — press Enter to skip)'}`);
  if (src) console.log(`    ↳ ${src}`);
  if (isSecret(v.key)) console.log('    ↳ input is hidden (not echoed)');
  while (true) {
    const value = isSecret(v.key) ? await askHidden('    value: ') : await askVisible('    value: ');
    if (!value && !v.required) return null;
    if (!value && v.required) { console.log(`    ❌ ${v.key} is required`); continue; }
    const validator = VALIDATORS[v.key];
    if (validator && !validator(value)) { console.log(`    ❌ ${v.key} failed validation, try again`); continue; }
    console.log(`    ✅ got ${v.key} (${redactValue(value)})`);
    return value;
  }
}

async function collect(ids, { force = false } = {}) {
  const env = currentEnv();
  const updates = {};
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) { console.log(`⚠️ unknown provider "${id}", skip`); continue; }
    const todo = p.vars.filter(v => force || !env[v.key]);
    if (todo.length === 0) { console.log(`  ✅ ${p.id}: already complete`); continue; }
    console.log(`\n── ${p.id.toUpperCase()} — ${p.title} ──`);
    console.log(`   ${p.blurb}`);
    if (p.status === 'stub') console.log('   ⚠️ this /sc-* script is not implemented yet; values are stored for later.');
    for (const v of todo) {
      if (!force && env[v.key]) continue;
      const val = await promptForVar(v, { force });
      if (val !== null) updates[v.key] = val;
    }
  }
  return updates;
}

async function cmdSetup(args) {
  if (!isInteractive()) die('sc setup needs a TTY. Non-interactive? Use:\n   printf \'KEY=VALUE\\n\' | node skills/sc-onboarding/scripts/scan-env.js --write-stdin');
  console.log('\n🚀 si-coder setup\n');
  let ids = resolveIds(args);
  if (!ids) {
    const items = providerItems();
    // Pre-tick whatever is actually incomplete: the common case is "fix what is broken",
    // and starting from an empty list would make the user re-derive that by hand.
    const pre = items.filter(i => i.needsAttention).map(i => i.id);
    ids = await selectMany('Which providers do you want to set up?', items, pre);
    if (ids === null) { console.log('cancelled'); return; }
    if (ids.length === 0) { console.log('Nothing selected.'); return; }
  }
  const updates = await collect(ids, { force: Boolean(args.force) });
  if (Object.keys(updates).length === 0) { console.log('\n✅ Nothing to write — everything asked for is already set.'); return; }
  appendExportToShellRc(updates);
  console.log(`\n✅ Wrote ${Object.keys(updates).length} export(s) to ~/.bashrc`);
  console.log('\nNext:\n  source ~/.bashrc\n  sc doctor');
}

async function cmdProvidersSet(id) {
  if (!isInteractive()) die('sc providers set needs a TTY.');
  if (!id) id = await pickProvider('Re-enter credentials for which provider?');
  byId.get(id) || die(`unknown provider "${id}"`);
  console.log(`\n🔁 re-entering every var for "${id}" (existing values will be replaced)\n`);
  const updates = await collect([id], { force: true });
  if (Object.keys(updates).length === 0) { console.log('\nNothing entered — no change.'); return; }
  appendExportToShellRc(updates);
  console.log(`\n✅ Wrote ${Object.keys(updates).length} export(s). Run: source ~/.bashrc`);
}

async function cmdProvidersRm(id, args) {
  if (!id) id = await pickProvider('Remove credentials for which provider?');
  const p = byId.get(id) || die(`unknown provider "${id}"`);
  const keys = p.vars.map(v => v.key);
  console.log(`\nThis removes from the si-coder block in ~/.bashrc:\n  ${keys.join('\n  ')}\n`);
  if (!args.yes) {
    if (!isInteractive()) die('refusing to remove without --yes on a non-TTY.');
    if (!await confirm('Remove them?')) { console.log('aborted'); return; }
  }
  const { removed, unmanaged } = removeExportsFromShellRc(keys);
  console.log(removed.length ? `✅ removed: ${removed.join(', ')}` : 'nothing to remove in the managed block');
  if (unmanaged.length) {
    console.log(`⚠️ still exported OUTSIDE the si-coder block (left untouched, edit ~/.bashrc by hand): ${unmanaged.join(', ')}`);
  }
  console.log('Run: source ~/.bashrc   (a removed var stays in THIS shell until you start a new one)');
}

// ---------------------------------------------------------------------------
// doctor — live verification
// ---------------------------------------------------------------------------
async function cmdDoctor(args) {
  const env = currentEnv();
  const ids = resolveIds(args) || PROVIDERS.filter(p => p.status !== 'stub').map(p => p.id);
  console.log('\n🩺 sc doctor — live verification against each provider API\n');
  let fails = 0, checked = 0;
  const results = await Promise.all(ids.map(async id => {
    const p = byId.get(id);
    let r;
    try { r = await p.check(env); } catch (e) { r = { ok: false, detail: `check threw: ${e.message}` }; }
    return { p, r };
  }));
  for (const { p, r } of results) {
    const icon = r.ok === true ? '✅' : r.ok === false ? '❌' : '⚪';
    if (r.ok === false) fails++;
    if (r.ok !== null) checked++;
    console.log(`  ${icon} ${p.id.padEnd(14)} ${r.detail}`);
  }
  console.log(`\n  ${checked} verified live, ${fails} failing, ${results.length - checked} not verifiable here.\n`);
  if (fails) process.exit(1);
}

// ---------------------------------------------------------------------------
// preflight — the gate /sc-all runs before it touches anything
// ---------------------------------------------------------------------------
async function cmdPreflight(args) {
  const target = args.target || 'dokploy';
  const ids = TARGET_PROVIDERS[target] || die(`unknown --target "${target}"`);
  const env = currentEnv();

  const missing = [];
  for (const id of ids) {
    for (const v of byId.get(id).vars) {
      if (v.required && !env[v.key]) missing.push({ id, key: v.key });
    }
  }
  if (missing.length === 0) {
    console.log(`✅ preflight ok for --target ${target} (${ids.join(', ')})`);
    return;
  }

  console.log(`\n⚠️ --target ${target} needs ${missing.length} credential(s) that are not set:\n`);
  for (const m of missing) console.log(`   • ${m.key}   (${m.id})`);

  // Auto-launch ONLY on a real terminal. Prompting on a closed or piped stdin does not ask a
  // question, it hangs the job — so CI gets the exact command instead and exits non-zero.
  if (!isInteractive()) {
    console.log(`\n❌ Not a TTY — refusing to prompt. Run this first:\n`);
    console.log(`   node ${path.relative(process.cwd(), __filename)} setup --target ${target}\n`);
    process.exit(1);
  }
  console.log('');
  if (!await confirm('Enter them now?')) die('aborted — deploy not started', 1);
  const updates = await collect(ids);
  if (Object.keys(updates).length) {
    appendExportToShellRc(updates);
    console.log(`\n✅ Wrote ${Object.keys(updates).length} export(s) to ~/.bashrc`);
    // The parent shell cannot be mutated from here, so the caller must re-source before the
    // deploy reads process.env. Say so explicitly rather than letting it fail one step later.
    console.log('\n⚠️ Run `source ~/.bashrc` and re-run /sc-all — this process cannot change the parent shell.');
    process.exit(2);
  }
  die('still missing required credentials', 1);
}


// Bare `sc` on a terminal opens the console rather than printing a wall of usage. On a pipe
// it still prints usage, so `sc | head` and scripts behave the way anyone would expect.
async function cmdMenu() {
  const action = await selectOne('sc — si-coder provider console', [
    { id: 'providers', label: 'providers', hint: 'see what is configured' },
    { id: 'setup',     label: 'setup    ', hint: 'fill in what is missing' },
    { id: 'doctor',    label: 'doctor   ', hint: 'live check against each real API' },
    { id: 'show',      label: 'show     ', hint: 'detail for one provider' },
    { id: 'set',       label: 'set      ', hint: 'rotate one provider\'s credentials' },
    { id: 'rm',        label: 'rm       ', hint: "remove one provider's vars from ~/.bashrc" },
    { id: 'preflight', label: 'preflight', hint: 'check a /sc-all deploy target' },
    { id: 'quit',      label: 'quit     ', hint: '' },
  ]);
  switch (action) {
    case 'providers': return cmdProvidersList({});
    case 'setup':     return cmdSetup({});
    case 'doctor':    return cmdDoctor({});
    case 'show':      return cmdProvidersShow(undefined);
    case 'set':       return cmdProvidersSet(undefined);
    case 'rm':        return cmdProvidersRm(undefined, {});
    case 'preflight': {
      const target = await selectOne('Which /sc-all target?', Object.entries(TARGET_PROVIDERS)
        .map(([t, ids]) => ({ id: t, label: t.padEnd(9), hint: `needs: ${ids.join(', ')}` })));
      if (!target) return;
      return cmdPreflight({ target });
    }
    default: return;
  }
}

// ---------------------------------------------------------------------------
function usage() {
  console.log(`
sc — si-coder provider console

  sc providers                      list every provider and what is configured
  sc providers show <id>            per-var detail for one provider
  sc providers set  <id>            re-enter (rotate) every var for one provider
  sc providers rm   <id> [--yes]    remove its vars from the ~/.bashrc managed block
  sc setup [--providers a,b] [--target t] [--force]
                                    interactive wizard for whatever is missing
  sc doctor [--providers a,b] [--target t]
                                    LIVE check: call each real API, report what works
  sc preflight --target <dokploy|hybrid|vercel>
                                    gate used by /sc-all

  providers: ${PROVIDERS.map(p => p.id).join(', ')}
  targets  : ${Object.keys(TARGET_PROVIDERS).join(', ')}
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub, arg] = args._;
  switch (cmd) {
    case 'providers':
      if (!sub) return cmdProvidersList(args);
      if (sub === 'show') return cmdProvidersShow(arg);
      if (sub === 'set') return cmdProvidersSet(arg);
      if (sub === 'rm') return cmdProvidersRm(arg, args);
      return die(`unknown: providers ${sub}`);
    case 'setup':     return cmdSetup(args);
    case 'doctor':    return cmdDoctor(args);
    case 'preflight': return cmdPreflight(args);
    case undefined:   return isInteractive() ? cmdMenu() : usage();
    case 'menu':      return cmdMenu();
    case 'help':      return usage();
    default:          usage(); return die(`unknown command "${cmd}"`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
