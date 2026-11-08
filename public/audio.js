/* Audio processors are confined to voice. Shared music has its own untouched path. AGPL-3.0-only. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FriendsAudio=api;})(typeof window==='object'?window:globalThis,function(){
    'use strict';
    const gainValue=percent=>Math.max(0,Math.min(4,Number(percent)/100||0));
    class VoicePipeline {
        constructor(){this.context=null;this.raw=null;this.output=null;this.nodes=[];this.worklet=null;this.mode='off';this.muted=false;}
        async start(raw,{mode='rnnoise',gain=150}={}){
            await this.stop();this.raw=raw;
            const context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});this.context=context;await context.resume();
            const source=context.createMediaStreamSource(raw), destination=context.createMediaStreamDestination();
            destination.channelCount=1;destination.channelCountMode='explicit';
            this.gain=context.createGain();this.gain.gain.value=gainValue(gain);
            const limiter=context.createDynamicsCompressor();limiter.threshold.value=-1;limiter.knee.value=0;limiter.ratio.value=20;limiter.attack.value=.003;limiter.release.value=.1;
            this.analyser=context.createAnalyser();this.analyser.fftSize=512;
            this.nodes=[source,this.gain,limiter,this.analyser,destination];
            let tail=source;this.mode=mode;this.fallback=false;
            if(mode==='rnnoise'){
                try {
                    await context.audioWorklet.addModule('noiseSuppressionProcessor.js');
                    const node=new AudioWorkletNode(context,'noiseSuppressionProcessor',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});this.worklet=node;
                    await new Promise((resolve,reject)=>{
                        const timer=setTimeout(()=>reject(new Error('神经网络降噪初始化超时')),12000);
                        node.port.onmessage=async({data})=>{
                            try{
                                if(data.type==='request-wasm'){
                                    const response=await fetch('rnnoise.wasm');if(!response.ok)throw new Error('无法加载本地降噪模型');
                                    const bytes=await response.arrayBuffer();node.port.postMessage({type:'wasm-module',wasmBytes:bytes},[bytes]);
                                }else if(data.type==='wasm-ready'){clearTimeout(timer);resolve();}
                                else if(data.type==='wasm-error'){clearTimeout(timer);reject(new Error(data.error));}
                            }catch(error){clearTimeout(timer);reject(error);}
                        };
                        node.onprocessorerror=()=>{clearTimeout(timer);reject(new Error('降噪处理器异常'));};
                    });
                    node.port.postMessage({type:'enable',enabled:true});source.connect(node);tail=node;
                }catch(error){
                    console.warn(error);this.worklet?.disconnect();this.worklet=null;this.mode='browser';this.fallback=true;
                    const track=raw.getAudioTracks()[0];await track.applyConstraints({...track.getConstraints(),noiseSuppression:true});
                }
            }
            tail.connect(this.gain);this.gain.connect(limiter);limiter.connect(this.analyser);this.analyser.connect(destination);
            this.output=destination.stream;this.setMuted(false);return this.output;
        }
        setGain(value){if(this.gain)this.gain.gain.setTargetAtTime(gainValue(value),this.context.currentTime,.015);}
        setMuted(value){this.muted=!!value;this.output?.getAudioTracks().forEach(t=>t.enabled=!value);this.raw?.getAudioTracks().forEach(t=>t.enabled=!value);}
        level(){if(!this.analyser||this.muted)return 0;const a=new Float32Array(this.analyser.fftSize);this.analyser.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);}
        async stop(){
            this.worklet?.port.postMessage({type:'destroy'});try{this.worklet?.disconnect();}catch{}
            for(const node of this.nodes)try{node.disconnect();}catch{}
            this.output?.getTracks().forEach(t=>t.stop());
            if(this.context&&this.context.state!=='closed')await this.context.close();
            this.context=null;this.output=null;this.raw=null;this.nodes=[];this.worklet=null;this.analyser=null;
        }
    }
    class OutputMixer {
        constructor(){this.context=null;this.entries=new Map();this.levels=new Map();this.deafened=false;this.master=1;}
        async ready(){if(!this.context)this.context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});if(this.context.state==='suspended')await this.context.resume();return this.context;}
        async attach(key,stream,{volume=100}={}){
            const context=await this.ready();this.remove(key);
            // The HTML element primes Chromium's WebRTC receiver, but playback is
            // exclusively through this per-track WebAudio path (no double sound).
            const audio=document.createElement('audio');audio.autoplay=true;audio.volume=0;audio.srcObject=stream;audio.hidden=true;document.body.append(audio);
            audio.play().catch(()=>{});
            const source=context.createMediaStreamSource(stream), gain=context.createGain();
            source.connect(gain);gain.connect(context.destination);
            const entry={audio,source,gain,volume:this.levels.get(key)??gainValue(volume)};this.entries.set(key,entry);this.apply(entry);return entry;
        }
        apply(entry){entry.gain.gain.setTargetAtTime(this.deafened?0:entry.volume*this.master,this.context.currentTime,.01);}
        volume(key,value){const level=gainValue(value);this.levels.set(key,level);const entry=this.entries.get(key);if(entry){entry.volume=level;this.apply(entry);}}
        deafen(value){this.deafened=!!value;for(const entry of this.entries.values())this.apply(entry);}
        masterVolume(value){this.master=gainValue(value);for(const entry of this.entries.values())this.apply(entry);}
        async sink(id){const context=await this.ready();if(context.setSinkId)await context.setSinkId(id||'');else if(id)throw new Error('当前音频引擎不能选择输出设备');}
        remove(key){const entry=this.entries.get(key);if(!entry)return;entry.source.disconnect();entry.gain.disconnect();entry.audio.pause();entry.audio.srcObject=null;entry.audio.remove();this.entries.delete(key);}
        async stop(){for(const key of [...this.entries.keys()])this.remove(key);this.levels.clear();this.deafened=false;if(this.context&&this.context.state!=='closed')await this.context.close();this.context=null;}
    }
    return {VoicePipeline,OutputMixer,gainValue};
});
