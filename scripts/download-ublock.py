#!/usr/bin/env python3
"""Download only uBO Lite's CWS CRX into a fresh directory; never execute its files."""
import pathlib, urllib.request, tempfile, struct, zipfile, io, hashlib, json, os
ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
base = pathlib.Path.home() / 'Library/Application Support/Olive Extensions'
base.mkdir(parents=True, exist_ok=True)
root = pathlib.Path(tempfile.mkdtemp(prefix='ubol-', dir=base))
url = 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=152.0.0.0&acceptformat=crx3&x=id%3D'+ID+'%26installsource%3Dondemand%26uc'
with urllib.request.urlopen(url, timeout=40) as response:
    data = response.read(30*1024*1024+1)
assert len(data) <= 30*1024*1024 and data[:4] == b'Cr24', 'not a supported CRX'
version, size = struct.unpack('<II', data[4:12])
assert version == 3 and size < len(data)-12, 'invalid CRX3 header'
(root/'package.crx').write_bytes(data)
package = root/'unpacked'; package.mkdir()
with zipfile.ZipFile(io.BytesIO(data[12+size:])) as z:
    assert sum(x.file_size for x in z.infolist()) < 120*1024*1024
    for entry in z.infolist():
        dest = (package/entry.filename).resolve()
        assert str(dest).startswith(str(package)+'/'), 'unsafe archive path'
        assert ((entry.external_attr >> 16) & 0o170000) != 0o120000, 'symlink rejected'
    z.extractall(package)
manifest = json.loads((package/'manifest.json').read_text())
assert manifest['manifest_version'] == 3 and manifest['author'] == 'Raymond Hill'
record = dict(storeId=ID, version=manifest['version'], path=str(package), sha256=hashlib.sha256(data).hexdigest(), source=url)
# Pin these exact unpacked bytes; the app checks them before loading.
record['files'] = {str(p.relative_to(package)): hashlib.sha256(p.read_bytes()).hexdigest() for p in package.rglob('*') if p.is_file()}
with (base/'ublock.json').open('w') as f: json.dump(record, f, indent=2)
os.chmod(base/'ublock.json', 0o600)
print(json.dumps({k:v for k,v in record.items() if k != 'files'}, indent=2))
