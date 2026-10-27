// Trusted app settings are full inline pages. No floating card, scrim or window.
const {InlinePage}=require('./inline-page');
class AppPanel extends InlinePage {
  constructor(owner,options={}) {
    owner?.appPanel?.close();
    super(owner,{...options,kind:'settings'});
    owner.appPanel=this;
  }
  close(){if(this.owner?.appPanel===this)this.owner.appPanel=null;super.close();}
}
module.exports={AppPanel};
