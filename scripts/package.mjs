// build Olive.app (Developer ID signed) and install it to ~/Applications/Olive.app
// usage: npm run package               (OLIVE_NO_INSTALL=1 to skip the copy)
//        npm run package -- --release  (sign for distribution, notarize + staple the app,
//                                       build/sign/notarize/staple a dmg in dist/; never installs)
//   OLIVE_NOTARY_PROFILE  notarytool keychain profile (default retune-notary)
//   OLIVE_DMG_NAME        dmg file name (default Olive-<version>-<git short>-<arch>.dmg)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const release = process.argv.includes('--release') || process.env.OLIVE_RELEASE === '1';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// Use a certificate-backed identity, not an ad-hoc cdhash requirement that changes
// with app.asar. Do not silently downgrade an installed app's privacy identity.
const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']).toString();
const identity = process.env.OLIVE_SIGN_IDENTITY || identities.match(/"(Developer ID Application: Retune AI Inc \(GLUU6G59Y3\))"/)?.[1];
if (!identity) throw new Error('A stable signing identity is required. Set OLIVE_SIGN_IDENTITY to an installed Developer ID identity.');

// node here may run under rosetta (x64); build for the real cpu
const arch = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).toString().trim() === '1' ? 'arm64' : 'x64';
const [appDir] = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  overwrite: true,
  platform: 'darwin',
  arch,
  name: 'Olive',
  executableName: 'Olive',
  appBundleId: 'com.reframe.olive',
  helperBundleId: 'com.reframe.olive.helper',
  appCategoryType: 'public.app-category.productivity',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  icon: path.join(root, 'assets', 'icon.icns'),
  // Electron's fs.cpSync cannot recursively copy a virtual ASAR directory.
  // Keep verified bundled extension bytes on disk for profile-local installation.
  asar: { unpackDir: 'vendor/ublock' },
  prune: true,
  ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/assets\/icon\.(svg|png)$/, /^\/\.git($|\/)/, /^\/notes($|\/)/],
  protocols: [{ name: 'Web site URL', schemes: ['http', 'https'] }],
  extendInfo: {
    CFBundleDocumentTypes: [
      {
        CFBundleTypeName: 'HTML document',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.html', 'public.xhtml', 'public.url'],
      },
    ],
    NSCameraUsageDescription: 'Websites you allow can use your camera.',
    NSMicrophoneUsageDescription: 'Websites you allow can use your microphone.',
    NSLocationUsageDescription: 'Websites you allow can use your location.',
    NSLocationWhenInUseUsageDescription: 'Websites you allow can use your location.',
    NSHumanReadableCopyright: 'Olive, local build',
  },
});

const app = path.join(appDir, 'Olive.app');
// Fail before signing if ASAR packaging has left the blocker in a virtual directory.
const blocker = path.join(app, 'Contents/Resources/app.asar.unpacked/vendor/ublock');
const blockerRecord = JSON.parse(fs.readFileSync(path.join(blocker, 'record.json'), 'utf8'));
for (const file of Object.keys(blockerRecord.files)) {
  if (!fs.statSync(path.join(blocker, 'unpacked', file)).isFile()) throw new Error(`Missing packaged blocker file: ${file}`);
}
// Sign inside-out, every Mach-O and nested bundle on its own, deepest first, then the
// app. A single `codesign --deep` pass (the old path) left Electron's loose dylibs
// (libffmpeg, libvk_swiftshader, ...) ad-hoc signed, and --timestamp=none gave no
// secure timestamp, so the first notarization was rejected ("not signed with a valid
// Developer ID certificate" / "does not include a secure timestamp"). Stale *.cstemp
// files and Finder xattrs from an interrupted run also break the seal; clear them first.
const entitlements = path.join(root, 'assets', 'entitlements.plist');
const timestamp = release ? '--timestamp' : '--timestamp=none';
run('/usr/bin/xattr', ['-cr', app]);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  if (e.isSymbolicLink()) return [];
  return e.isDirectory() ? [...walk(p), p] : [p];
});
for (const file of walk(app)) if (file.endsWith('.cstemp')) fs.rmSync(file, { force: true });
const isMachO = file => {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
  return ['feedfacf', 'cffaedfe', 'cafebabe', 'feedface', 'cefaedfe'].includes(b.toString('hex'));
};
const bundle = p => /\.(app|framework|xpc|appex|bundle)$/.test(p);
const depth = p => p.split(path.sep).length;
const contents = path.join(app, 'Contents');
// Loose Mach-O files (dylibs, helper tools like chrome_crashpad_handler); a bundle's own
// main executable is sealed when the bundle itself is signed.
const looseFiles = walk(contents).filter(p => fs.statSync(p).isFile() && !/\/(Contents\/)?MacOS\/[^/]+$/.test(p.slice(contents.length)) && isMachO(p))
  .filter(p => !/\.framework\/Versions\/[^/]+\/[^/]+$/.test(p) || /\/(Libraries|Helpers)\//.test(p));
const nestedBundles = walk(contents).filter(p => bundle(p) && fs.statSync(p).isDirectory());
const sign = (target, withEntitlements) => run('/usr/bin/codesign', ['--force', '--options', 'runtime', timestamp,
  ...(withEntitlements ? ['--entitlements', entitlements] : []), '--sign', identity, target]);
for (const file of looseFiles.sort((a, b) => depth(b) - depth(a))) sign(file, false);
for (const nested of nestedBundles.sort((a, b) => depth(b) - depth(a))) sign(nested, nested.endsWith('.app'));
sign(app, true);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
// Every Mach-O must carry our Developer ID (notarization rejects ad-hoc/upstream signatures).
const authority = f => execFileSync('/bin/sh', ['-c', '/usr/bin/codesign -dvv "$1" 2>&1', 'sh', f]).toString();
const foreign = [...looseFiles, ...nestedBundles, app].filter(f => !authority(f).includes(`Authority=${identity}`) && !/^[0-9A-F]{40}$/.test(identity));
if (foreign.length) throw new Error('Not signed with ' + identity + ': ' + foreign.join(', '));
console.log('signed with stable identity:', identity, release ? '(secure timestamp)' : '(no timestamp)');
console.log('built', app);

if (release) {
  const profile = process.env.OLIVE_NOTARY_PROFILE || 'retune-notary';
  const short = (() => { try { return execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', '--short', 'HEAD']).toString().trim(); } catch { return 'local'; } })();
  const dist = path.join(root, 'dist');
  const notarize = file => {
    // Credentials stay in the keychain profile; nothing secret is printed.
    const out = execFileSync('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    const result = JSON.parse(out);
    console.log('notarytool', path.basename(file), result.status, result.id);
    if (result.status !== 'Accepted') {
      try { run('/usr/bin/xcrun', ['notarytool', 'log', result.id, '--keychain-profile', profile]); } catch {}
      throw new Error(`Notarization ${result.status} for ${path.basename(file)} (${result.id})`);
    }
    return result;
  };
  // 1. app: zip → notarize → staple, so the app itself carries its ticket after it leaves the dmg.
  const zip = path.join(dist, 'Olive-notarize.zip');
  fs.rmSync(zip, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  notarize(zip); fs.rmSync(zip, { force: true });
  run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  // 2. dmg: Olive.app + /Applications link, signed, notarized, stapled.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-dmg-stage-'));
  try {
    run('/usr/bin/ditto', [app, path.join(stage, 'Olive.app')]);
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    const dmg = path.join(dist, process.env.OLIVE_DMG_NAME || `Olive-${pkg.version}-${short}-${arch}.dmg`);
    fs.rmSync(dmg, { force: true });
    run('/usr/bin/hdiutil', ['create', '-volname', 'Olive', '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg]);
    run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmg]);
    notarize(dmg);
    run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
    run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    run('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
    run('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', app]);
    console.log('dmg', dmg);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (!release && !process.env.OLIVE_NO_INSTALL) {
  const dest = path.join(os.homedir(), 'Applications', 'Olive.app');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', [app, dest]);
  // register with launch services so "default browser" pickers see it
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dest]);
  // drop the build copy so launch services only knows the installed app (one "Olive" in
  // the default-browser list)
  try { execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]); } catch {}
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  console.log('installed', dest);
}
