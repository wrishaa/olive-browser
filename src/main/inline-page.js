// A trusted app page in the same rounded pane as web content, not a window.
const {EventEmitter}=require('node:events');
const {WebContentsView}=require('electron');
class InlinePage extends EventEmitter {
  constructor(owner,options={}) {
    super();
    if(!owner?.win||owner.isPrivate||owner.win.isDestroyed())throw new Error('Open a normal Olive window first');
    owner.inlinePage?.close();
    this.owner=owner;this.options=options;this.kind=options.kind||'setup';this.closed=false;owner.inlinePage=this;
    this.content=new WebContentsView({webPreferences:options.webPreferences});
    this.webContents=this.content.webContents;
    this.content.setBackgroundColor('#00000000');this.content.setBorderRadius(10);
    this.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    this.webContents.on('will-navigate',e=>e.preventDefault());
    this.webContents.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown'&&input.key==='Escape'&&!options.captureEscape){event.preventDefault();this.close();}
    });
    this.parentClosed=()=>this.close();owner.win.once('closed',this.parentClosed);
    owner.win.contentView.addChildView(this.content);
    owner.setOverlay(null);owner.layout();owner.sendState();
  }
  geometry(){const {width,height}=this.owner.win.getContentBounds();const x=this.owner.sidebarHidden?8:this.owner.sidebarWidth;return{x,y:8,width:Math.max(100,width-x-8),height:Math.max(100,height-16)};}
  layout(){if(this.closed||this.owner.win.isDestroyed())return;this.content.setBounds(this.geometry());this.content.setVisible(true);if(!this.owner.overlay)this.owner.win.contentView.addChildView(this.content);}
  loadFile(...args){return this.webContents.loadFile(...args);}
  setMenu(){}
  show(){this.owner.layout();this.owner.sendState();}
  focus(){if(!this.closed){this.owner.win.focus();this.webContents.focus();}}
  isDestroyed(){return this.closed;}
  close(){if(this.closed)return;this.closed=true;this.owner.win.removeListener('closed',this.parentClosed);if(!this.owner.win.isDestroyed())this.owner.win.contentView.removeChildView(this.content);if(!this.webContents.isDestroyed())this.webContents.close();if(this.owner.inlinePage===this)this.owner.inlinePage=null;this.emit('closed');if(!this.owner.destroyed){this.owner.layout();this.owner.sendState();this.owner.tabs.get(this.owner.activeId)?.wc?.focus();}}
}
module.exports={InlinePage};
