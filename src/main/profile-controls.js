// Profiles (olive://profiles): a normal tab. IPC answers only the main frame of an
// olive://profiles tab in a normal window (InternalPages.sender).
const { ipcMain }=require('electron');
class ProfileControls {
  constructor(mgr) {
    this.mgr=mgr;
    ipcMain.handle('olive:profiles',async(e,action,p={})=>{
      if(!mgr.internal?.sender(e,'profiles'))throw new Error('Not a profile settings page');
      p=p&&typeof p==='object'?p:{};
      try {
        if(action==='create'){const made=mgr.profiles.create(p.name);await mgr.switchProfile(made.id);}
        else if(action==='rename')mgr.profiles.rename(p.id,p.name);
        else if(action==='switch')await mgr.switchProfile(p.id);
        else if(action!=='get')throw new Error('Unknown profile action');
        mgr.broadcast();return {profiles:mgr.profiles.list(),error:null};
      } catch(err){return {profiles:mgr.profiles.list(),error:err.message};}
    });
  }
  // focus an open olive://profiles tab, else open one
  show(owner=this.mgr.focusedWindow?.()) { return this.mgr.internal.open('olive://profiles',{win:owner,reuse:()=>true}); }
}
module.exports={ProfileControls};
