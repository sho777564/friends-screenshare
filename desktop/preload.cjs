'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('friendsDesktop',{
    info:()=>ipcRenderer.invoke('desktop:info'),
    shareLogs: {
        write: entries => ipcRenderer.invoke('share-logs:write', entries),
        open: () => ipcRenderer.invoke('share-logs:open'),
    },
    diagnostics: {
        record: record=>ipcRenderer.invoke('diagnostics:record',record),
        export: ()=>ipcRenderer.invoke('diagnostics:export'),
    },
    sources:()=>ipcRenderer.invoke('desktop:sources'),
    selectSource:(id,audio)=>ipcRenderer.invoke('desktop:select',id,audio),
    window:action=>ipcRenderer.invoke('desktop:window',action),
    fullscreen:value=>ipcRenderer.invoke('desktop:fullscreen',value),
    mini: value => ipcRenderer.invoke('desktop:mini', value),
    callAlert: (ringing, name) => ipcRenderer.invoke('desktop:call-alert', ringing, name),
    updates: {
        status:()=>ipcRenderer.invoke('updates:status'),
        configure:url=>ipcRenderer.invoke('updates:configure',url),
        check:()=>ipcRenderer.invoke('updates:check'),
        download:automatic=>ipcRenderer.invoke('updates:download',automatic===true),
        local:()=>ipcRenderer.invoke('updates:local'),
        install:()=>ipcRenderer.invoke('updates:install'),
        onStatus:callback=>{const handler=(event,status)=>callback(status);ipcRenderer.on('desktop:update',handler);return()=>ipcRenderer.removeListener('desktop:update',handler);},
    },
    onMini: callback => {
        const handler = (event, enabled) => callback(enabled);
        ipcRenderer.on('desktop:mini-changed', handler);
        return () => ipcRenderer.removeListener('desktop:mini-changed', handler);
    },
    onFullscreen:callback=>{const handler=(event,value)=>callback(value);ipcRenderer.on('desktop:fullscreen-changed',handler);return()=>ipcRenderer.removeListener('desktop:fullscreen-changed',handler);},
    onInvite:callback=>{const handler=(event,room)=>callback(room);ipcRenderer.on('desktop:invite',handler);return()=>ipcRenderer.removeListener('desktop:invite',handler);},
    clipboard:text=>ipcRenderer.invoke('desktop:clipboard',text),
    remote:{
        grant:(peer,name)=>ipcRenderer.invoke('remote:grant',peer,name),
        input:(token,seq,input)=>ipcRenderer.invoke('remote:input',token,seq,input),
        stop:peer=>ipcRenderer.invoke('remote:stop',peer),
        shareEnded:()=>ipcRenderer.invoke('remote:share-ended'),
        capture:value=>ipcRenderer.invoke('remote:capture',value),
        onEvent:callback=>{const fn=(event,data)=>callback(data);ipcRenderer.on('remote:event',fn);return()=>ipcRenderer.removeListener('remote:event',fn);},
    },
    files:{
        add:file=>ipcRenderer.invoke('files:source',webUtils.getPathForFile(file)),
        read:token=>ipcRenderer.invoke('files:read',token),
        sourceEnd:token=>ipcRenderer.invoke('files:source-end',token),
        sourceClose:token=>ipcRenderer.invoke('files:source-close',token),
        accept:meta=>ipcRenderer.invoke('files:accept',meta),
        write:(token,bytes)=>ipcRenderer.invoke('files:write',token,bytes),
        finish:(token,digest)=>ipcRenderer.invoke('files:finish',token,digest),
        cancel:token=>ipcRenderer.invoke('files:cancel',token),
        reveal:receipt=>ipcRenderer.invoke('files:reveal',receipt),
        fixture:size=>ipcRenderer.invoke('files:fixture',size),
        fixtureSource:file=>ipcRenderer.invoke('files:fixture-source',file),
    },
    saveTest:data=>ipcRenderer.invoke('desktop:save-test',data),
    testSurface:action=>ipcRenderer.invoke('desktop:test-surface',action),
    testMini: () => ipcRenderer.invoke('desktop:test-mini'),
    testTone:value=>ipcRenderer.invoke('desktop:test-tone',value),
    onShortcut:callback=>{const handler=(event,action)=>callback(action);ipcRenderer.on('desktop:shortcut',handler);return()=>ipcRenderer.removeListener('desktop:shortcut',handler);},
});
