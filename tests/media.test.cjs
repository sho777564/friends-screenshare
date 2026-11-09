'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tuneSdp, displayConstraints, codecOrder } = require('../public/media.js');
const {videoHint,degradationFor,directIceServers}=require('../public/media.js');
test('balanced sharing avoids an unconditional preference for dropping resolution',()=>{assert.equal(videoHint('balanced'),'motion');assert.equal(degradationFor('balanced'),'balanced');assert.equal(degradationFor('detail'),'maintain-resolution');assert.equal(degradationFor('motion'),'maintain-framerate');});
test('initial ICE keeps STUN and delays TURN without modifying relay credentials',()=>{const servers=[{urls:['stun:example:3478','turn:example:3478'],username:'test',credential:'secret'},{urls:'turns:example:443'}];assert.deepEqual(directIceServers(servers),[{urls:['stun:example:3478'],username:'test',credential:'secret'}]);assert.equal(servers[0].urls.length,2);});
test('Opus music parameters only affect the separate screen audio section', () => {
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
    const updated = tuneSdp(sdp), sections = updated.split(/(?=^m=)/m);
    assert.match(sections[1], /stereo=0/); assert.match(sections[1], /maxaveragebitrate=64000/);
    assert.match(sections[2], /stereo=1/); assert.match(sections[2], /maxaveragebitrate=256000/);
    assert.match(sections[3], /x-google-start-bitrate=2500/);
    assert.doesNotMatch(updated, /\r\r|[^\r]\n/);
    assert.match(updated, /a=rtpmap:96 VP8\/90000\r\na=fmtp:96 x-google-start-bitrate=2500\r\n/);
    assert.equal(tuneSdp(updated), updated, 'no duplicate fmtp after renegotiation');
});
test('Screen capture preserves music and requests bounded 1080p60', () => {
    const c = displayConstraints();
    assert.equal(c.audio.echoCancellation, false); assert.equal(c.audio.noiseSuppression, false); assert.equal(c.audio.autoGainControl, false);
    assert.equal(c.audio.channelCount.ideal, 2); assert.equal(c.video.width.max, 1920); assert.equal(c.video.frameRate.ideal, 60);
});
test('Codec preferences preserve fallback and retransmission codecs', () => {
    const codecs = ['video/VP8', 'video/rtx', 'video/H264', 'video/VP9'].map(mimeType => ({ mimeType }));
    assert.deepEqual(codecOrder(codecs, 'H264').map(c => c.mimeType), ['video/H264', 'video/VP8', 'video/rtx', 'video/VP9']);
    assert.deepEqual(codecOrder(codecs, 'AV1'), codecs);
});
