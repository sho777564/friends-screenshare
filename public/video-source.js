'use strict';
const canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d',{alpha:false});
function draw(time){
    ctx.fillStyle='#13262e';ctx.fillRect(0,0,1920,1080);
    for(let y=0;y<1080;y+=64)for(let x=0;x<1920;x+=64){ctx.fillStyle=((x+y)/64)%2?'#244e60':'#193b49';ctx.fillRect(x,y,32,32);}
    for(let n=0;n<18;n++){ctx.fillStyle=`hsl(${(n*21+time/90)%360} 70% 55%)`;ctx.fillRect((time*.35+n*143)%2200-280,n*58,280,30);}
    ctx.fillStyle='white';ctx.font='40px sans-serif';ctx.fillText('1920 × 1080 / moving capture fixture',60,495);ctx.font='24px monospace';ctx.fillText((time/1000).toFixed(3)+' seconds',60,550);
    ctx.font='16px sans-serif';ctx.fillText('Small text ABCDEFG 123456789 — native capture, no personal window',60,590);
    requestAnimationFrame(draw);
}requestAnimationFrame(draw);
