// build Olive.app (local, Developer ID signed) and install it to ~/Applications/Olive.app
// usage: npm run package          (OLIVE_NO_INSTALL=1 to skip the copy)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Use a certificate-backed identity, not an ad-hoc cdhash requirement that changes
// with app.asar. Do not silently downgrade an installed app's privacy identity.
const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']).toString();
const identity = process.env.OLIVE_SIGN_IDENTITY || identities.match(/"(Developer ID Application: Retune AI Inc \(GLUU6G59Y3\))"/)?.[1];
if (!identity) throw new Error('A stable signing identity is required. Set OLIVE_SIGN_IDENTITY to an installed Developer ID identity.');

const [appDir] = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  overwrite: true,
  platform: 'darwin',
  // node here may run under rosetta (x64); build for the real cpu
  arch: execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).toString().trim() === '1' ? 'arm64' : 'x64',
  name: 'Olive',
  executableName: 'Olive',
  appBundleId: 'com.reframe.olive',
  helperBundleId: 'com.reframe.olive.helper',
  appCategoryType: 'public.app-category.productivity',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  icon: path.join(root, 'assets', 'icon.icns'),
  asar: true,
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
    NSHumanReadableCopyright: 'Olive, local build',
  },
});

const app = path.join(appDir, 'Olive.app');
// One keychain access/signing invocation for the entire bundle, not a per-file
// osx-sign loop. The user must approve the key once with Always Allow.
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--options', 'runtime',
  '--entitlements', path.join(root, 'assets', 'entitlements.plist'),
  '--timestamp=none', '--sign', identity, app], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
console.log('signed with stable identity:', identity);
console.log('built', app);

if (!process.env.OLIVE_NO_INSTALL) {
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
