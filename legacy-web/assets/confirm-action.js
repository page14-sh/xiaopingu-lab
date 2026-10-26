// Page-owned confirmation: no blocking browser/native JavaScript dialogs.
(function(global){
  global.XPG_CONFIRM=function(message,label){
    return new Promise(function(resolve){
      var prior=document.activeElement,dialog=document.createElement('dialog'),settled=false;
      dialog.setAttribute('aria-label','确认操作');
      dialog.style.cssText='max-width:min(90vw,460px);padding:24px;border:1px solid #E6E3DC;border-radius:14px;background:#fff;color:#2E2E2C;font:16px/1.7 "PingFang SC",sans-serif';
      var text=document.createElement('p');text.textContent=message;
      var cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消';
      var accept=document.createElement('button');accept.type='button';accept.textContent=label||'确认';
      function finish(value){if(settled)return;settled=true;dialog.close();dialog.remove();if(prior&&prior.isConnected)prior.focus();resolve(value);}
      cancel.addEventListener('click',function(){finish(false);});
      accept.addEventListener('click',function(){finish(true);});
      dialog.addEventListener('cancel',function(event){event.preventDefault();finish(false);});
      dialog.addEventListener('close',function(){finish(false);});
      dialog.append(text,cancel,accept);document.body.append(dialog);dialog.showModal();cancel.focus();
    });
  };
})(window);
