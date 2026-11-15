import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './verify-mac-signing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const work = join(root, '.build/upgrade-test');
export const planFile = join(work, 'plan.json');
export const readPlan = async () => JSON.parse(await readFile(planFile, 'utf8'));
const port = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
export function child(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const job = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    job.once('error', reject); job.once('exit', (code) => code === 0 ? resolve() : reject(new Error(args[0] + ' exited ' + code)));
  });
}
// Remove this run's (or an interrupted earlier run's) loopback certificate from the keychain, then delete it and its key.
// Changing the user's trust settings asks for confirmation in a system dialog, which nobody can answer on a CI runner
// (the trust step waited until the job timed out). GitHub's macOS runners are ephemeral with passwordless sudo, so there
// the certificate is trusted in the admin trust settings instead, which needs no dialog. Local runs keep the user
// domain and its one-time confirmation.
const adminTrust = process.env.GITHUB_ACTIONS === 'true';
const systemKeychain = '/Library/Keychains/System.keychain';
const security = (args, admin = adminTrust) => admin ? run('sudo', ['-n', 'security', ...args]) : run('security', args);
async function untrust() {
  const certificate = join(work, 'tls.crt');
  try { await access(certificate); } catch { return; }
  let saved;
  try { saved = JSON.parse(await readFile(join(work, 'tls-keychain.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Earlier runs saved only the keychain path, for the user domain.
  const { keychain, admin } = typeof saved === 'string' ? { keychain: saved, admin: false } : saved ?? {};
  // In the admin domain remove-trusted-cert waits for a confirmation even with sudo; deleting the certificate from the
  // System keychain removes it together with its trust settings (checked on a GitHub runner).
  if (!admin) { try { await security(['remove-trusted-cert', certificate], false); } catch { /* trust settings may already be gone */ } }
  if (keychain) {
    const { stdout } = await run('openssl', ['x509', '-in', certificate, '-noout', '-fingerprint', '-sha1']);
    const digest = stdout.trim().split('=').at(-1).replaceAll(':', '');
    await security(['delete-certificate', '-Z', digest, keychain], !!admin).catch(() => {});
  }
  await rm(join(work, 'tls.key'), { force: true });
  await rm(certificate, { force: true });
}
async function prepare() {
  // A killed earlier run cannot run its own cleanup; remove its trust before the folder holding its certificate.
  await untrust();
  await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
  const profile = join(work, 'profile'), book = join(work, 'Upgrade.imageflow');
  await mkdir(profile); await mkdir(join(book, 'template'), { recursive: true });
  await writeFile(join(book, 'photos.json'), '{}');
  await writeFile(join(book, 'project.json'), JSON.stringify({schemaVersion:1,title:'Upgrade test',template:{id:'upgrade-test',version:'1'},spreads:[{id:'first',definition:'base'}]}));
  await writeFile(join(book, 'template/index.tsx'), `import {defineTemplate,mm,p,Spread} from 'imageflow';
export default defineTemplate({id:'upgrade-test',version:'1',contract:1,formats:{base:{label:'Base',trim:{width:mm(80),height:mm(110)},
bleed:{top:mm(0),bottom:mm(0),outside:mm(0),binding:mm(0)},safe:{top:mm(5),bottom:mm(5),outside:mm(5),binding:mm(5)},
structure:{delivery:'pages',ends:'inside-covers',pageCount:{min:2,max:100,step:2}},output:{container:'pdf',colorSpace:'sRGB',transparency:'allow'}}},defaultFormat:'base',
parameters:{},spreads:{base:{label:'Base',parameters:{heading:p.string({label:'Heading',default:'Before upgrade'})},boxes:{},render:ctx=><Spread><h1>{ctx.params.heading}</h1></Spread>}}});`);
  const plan = { baseURL: `https://127.0.0.1:${await port()}/updates`, debugPort: await port(), profile, book,
    installed: join(work, 'Applications/ImageFlow.app'), versions: ['9.9.9-beta.1', '9.9.9-beta.2', '9.9.9', '9.9.10'] };
  for (const [index, version] of plan.versions.entries()) {
    await writeFile(join(work, `fixture-${index}.json`), JSON.stringify({ ...plan, version, output: join(work, String(index)) }));
  }
  await writeFile(planFile, JSON.stringify(plan, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const command = process.argv[2];
if (command === 'prepare') await prepare();
else if (command === 'build') {
  const plan = await readPlan();
  for (let index = 0; index < plan.versions.length; index++) await child(['scripts/package-mac.mjs', '--upgrade-fixture', join(work, `fixture-${index}.json`)]);

} else if (command === 'trust') {
  // A self-signed leaf (CA:FALSE) trusted for SSL only: it can't issue certificates for other hosts, even if the
  // key in .build were read before cleanup. The test removes this exact certificate and its key afterwards.
  // A fresh one-day key per run: nothing outlives cleanup, and reruns with --existing get a new certificate.
  await untrust();
  await writeFile(join(work, 'tls.conf'), `[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=ImageFlow upgrade test\n[extensions]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256', '-keyout', join(work, 'tls.key'),
    '-out', join(work, 'tls.crt'), '-config', join(work, 'tls.conf')]);
  await chmod(join(work, 'tls.key'), 0o600);
  const keychain = adminTrust ? systemKeychain : JSON.parse((await run('security', ['default-keychain', '-d', 'user'])).stdout.trim());
  await writeFile(join(work, 'tls-keychain.json'), JSON.stringify({ keychain, admin: adminTrust }));
  await security(['add-trusted-cert', ...(adminTrust ? ['-d'] : []), '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, join(work, 'tls.crt')]);
} else if (command === 'untrust') {
  await untrust();
} else throw new Error('Choose prepare, build, trust or untrust.');

}
