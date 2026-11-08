'use strict';
const context=new AudioContext({sampleRate:48000});
const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=1130;gain.gain.value=0;oscillator.connect(gain);gain.connect(context.destination);oscillator.start();context.resume();
setInterval(async()=>{try{const {active}=await(await fetch('/fixture-tone-state')).json();gain.gain.setTargetAtTime(active?.018:0,context.currentTime,.01);}catch{gain.gain.value=0;}},100);
