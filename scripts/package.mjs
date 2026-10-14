// build Olive.app (local, ad-hoc signed) and install it to ~/Applications/Olive.app
// usage: npm run package          (OLIVE_NO_INSTALL=1 to skip the copy)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

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
// ad-hoc signature so macOS treats it as one consistent bundle (no apple id needed)
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
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
