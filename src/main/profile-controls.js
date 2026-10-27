const { ipcMain }=require('electron');
const { AppPanel }=require('./app-panel');
const path=require('path');
class ProfileControls {
  constructor(mgr) {
    this.mgr=mgr;this.view=null;
    ipcMain.handle('olive:profiles',async(e,action,p={})=>{
      if(!this.view || this.view.isDestroyed() || e.sender!==this.view.webContents || e.senderFrame!==this.view.webContents.mainFrame)throw new Error('Not a profile settings window');
      if(action==='close'){this.view.close();return null;}
      try {
        if(action==='create'){const made=mgr.profiles.create(p.name);await mgr.switchProfile(made.id);}
        else if(action==='rename')mgr.profiles.rename(p.id,p.name);
        else if(action==='switch')await mgr.switchProfile(p.id);
        else if(action!=='get')throw new Error('Unknown profile action');
        mgr.broadcast();return {profiles:mgr.profiles.list(),error:null};
      } catch(err){return {profiles:mgr.profiles.list(),error:err.message};}
    });
  }
  show() {
    const owner=this.mgr.focusedWindow?.();
    if(!owner || owner.win.isDestroyed())return;
    if(this.view&&!this.view.isDestroyed()){
      if(this.view.owner===owner){this.view.show();this.view.focus();return;}
      this.view.close();
    }
    const view=this.view=new AppPanel(owner,{width:480,height:440,title:'profiles',webPreferences:{preload:path.join(__dirname,'../ui/profiles-preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    view.setMenu(null);view.webContents.on('will-navigate',e=>e.preventDefault());view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.loadFile(path.join(__dirname,'../ui/profiles.html'));view.once('closed',()=>{if(this.view===view)this.view=null;});
  }
}
module.exports={ProfileControls};
