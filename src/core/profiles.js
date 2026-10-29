// Profile metadata only. The existing profile stays at its original path/partition.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
class Profiles {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'profiles.json');
    const existing = ['session.json','permissions.json','history.json','Partitions/olive/Cookies'].some(p => fs.existsSync(path.join(root,p)));
    // onboarding.json is only ever written for a fresh (non-legacy) default profile.
    const freshBefore = fs.existsSync(path.join(root,'onboarding.json'));
    try { this.data = JSON.parse(fs.readFileSync(this.file,'utf8')); } catch (e) {
      if (fs.existsSync(this.file)) throw new Error('Profile registry could not be read. No profile was changed.');
      const legacy = existing && !freshBefore;
      this.data = { version:1, active:'default', profiles:[{id:'default',name:legacy ? 'Default (existing)' : 'Default',isLegacy:legacy,created:Date.now()}] };
      // Persist a fresh registry at once. Otherwise the next launch sees this run's
      // session.json, calls the profile legacy and setup can never open again.
      if (!legacy) this.save();
    }
    if (this.data.version !== 1 || !Array.isArray(this.data.profiles) || !this.data.profiles.some(p=>p.id==='default')) throw new Error('Invalid profile registry');
    if (this.data.profiles.some(p=>!this.validId(p.id))) throw new Error('Invalid profile identifier');
    if (!this.get(this.data.active)) this.data.active='default';
    // Heal registries saved after the bug above: a default profile with setup state was fresh.
    const def = this.get('default');
    if (def.isLegacy && freshBefore) { def.isLegacy=false; if (def.name==='Default (existing)') def.name='Default'; this.save(); }
  }
  validId(id) { return id==='default' || /^p-[a-f0-9]{24}$/.test(id); }
  list() { return this.data.profiles.map(p=>({...p,active:p.id===this.data.active})); }
  get(id) { return this.data.profiles.find(p=>p.id===id) || null; }
  get current() { return this.get(this.data.active); }
  directory(id=this.data.active) { if (!this.get(id)) throw new Error('Unknown profile'); return id==='default' ? this.root : path.join(this.root,'Profiles',id); }
  partition(id=this.data.active) { if (!this.get(id)) throw new Error('Unknown profile'); return id==='default' ? 'persist:olive' : `persist:olive-${id}`; }
  name(value) { const s=String(value||'').trim(); if (!s || s.length>60 || /[\x00-\x1f\x7f]/.test(s)) throw new Error('Use a profile name between 1 and 60 characters.'); if(this.data.profiles.some(p=>p.name.toLowerCase()===s.toLowerCase())) throw new Error('A profile already has that name.'); return s; }
  create(name) { const p={id:'p-'+crypto.randomBytes(12).toString('hex'),name:this.name(name),isLegacy:false,created:Date.now()};fs.mkdirSync(path.join(this.root,'Profiles',p.id),{recursive:true,mode:0o700});this.data.profiles.push(p);this.save();return {...p}; }
  rename(id,name) { const p=this.get(id);if(!p)throw new Error('Unknown profile');if(p.name===String(name).trim())return {...p};p.name=this.name(name);this.save();return {...p}; }
  activate(id) { if(!this.get(id))throw new Error('Unknown profile');this.data.active=id;this.save();return {...this.current}; }
  save() { fs.mkdirSync(this.root,{recursive:true,mode:0o700});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.data,null,2),{mode:0o600});fs.renameSync(temp,this.file);fs.chmodSync(this.file,0o600); }
}
module.exports={Profiles};
