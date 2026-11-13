// Same-session cooperative input. No service, elevation, network listener or key log.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class Arbitration {
    public long LocalKeys=-99999, LocalMouse=-99999;
    public bool Allowed(long now,bool keyboard){return now-LocalKeys>=1200 && now-LocalMouse>=(keyboard?700:300);}
}
class CoopInput:Form {
    class CoopPointer {public string id,name;public Color color;public double x,y;}
    readonly List<CoopPointer> collaborators=new List<CoopPointer>();
    [StructLayout(LayoutKind.Sequential)] struct POINT {public int x,y;public POINT(int a,int b){x=a;y=b;}}
    [StructLayout(LayoutKind.Sequential)] struct MOUSEHOOK {public POINT pt;public uint mouseData,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] struct KEYHOOK {public uint vk,scan,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {public int dx,dy;public uint mouseData,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] struct KEYINPUT {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Explicit)] struct UNION {[FieldOffset(0)]public MOUSEINPUT mouse;[FieldOffset(0)]public KEYINPUT key;}
    [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public UNION data;}
    delegate IntPtr Hook(int code,IntPtr msg,IntPtr data);
    [DllImport("user32.dll")]static extern uint SendInput(uint n,INPUT[] input,int size);
    [DllImport("user32.dll")]static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")]static extern IntPtr SetWindowsHookEx(int id,Hook hook,IntPtr mod,uint thread);
    [DllImport("user32.dll")]static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]static extern IntPtr CallNextHookEx(IntPtr hook,int c,IntPtr w,IntPtr l);
    [DllImport("kernel32.dll")]static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")]static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static TextReader commands;static TextWriter events;
    static bool testing=false;static readonly List<string> testInputs=new List<string>();
    readonly Arbitration arbiter=new Arbitration();
    readonly HashSet<int> keys=new HashSet<int>(),buttons=new HashSet<int>(),physicalKeys=new HashSet<int>(),physicalButtons=new HashSet<int>();
    Hook mh,kh;IntPtr mouseHook,keyHook,remoteFocus=IntPtr.Zero;
    POINT local,remote,systemPoint;Rectangle desktop;bool active=false,ending=false,focusPending=false,readerStarted=false;long pulse,focusAt;
    string localName="Local",remoteName="Remote";System.Windows.Forms.Timer timer;
    static long Now(){return (long)(System.Diagnostics.Stopwatch.GetTimestamp()*1000.0/System.Diagnostics.Stopwatch.Frequency);}
    static double Num(Dictionary<string,object> m,string k){return Convert.ToDouble(m[k]);}
    static string Field(Dictionary<string,object> m,string k){return Convert.ToString(m[k]);}
    static void Emit(object o){
        lock(Json){
            try{events.WriteLine(Json.Serialize(o));events.Flush();}
            catch(IOException){}
            catch(ObjectDisposedException){}
        }
    }
    static void ConfigureTransport(){commands=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true),false,4096);events=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false),4096){AutoFlush=true};}
    protected override bool ShowWithoutActivation{get{return true;}}
    protected override CreateParams CreateParams{get{var p=base.CreateParams;p.ExStyle|=0x80000|0x20|0x80|0x08000000;return p;}}
    public CoopInput(){
        FormBorderStyle=FormBorderStyle.None;BackColor=Color.Magenta;TransparencyKey=Color.Magenta;TopMost=true;ShowInTaskbar=false;DoubleBuffered=true;
        Bounds=new Rectangle(0,0,1,1);if(!testing)GetCursorPos(out local);remote=local;systemPoint=local;
        mh=MouseHook;kh=KeyboardHook;
        timer=new System.Windows.Forms.Timer();timer.Interval=40;timer.Tick+=(s,e)=>{
            if(!active)return;if(Now()-pulse>5000){Stop("heartbeat-timeout");return;}
            if(!testing)physicalKeys.RemoveWhere(vk=>(GetAsyncKeyState(vk)&0x8000)==0);
            if(focusPending&&Now()>focusAt){remoteFocus=GetForegroundWindow();focusPending=false;}
            if(!testing){Invalidate();Emit(new {type="cursor",x=Clamp((local.x-desktop.X)/(double)Math.Max(1,desktop.Width-1)),y=Clamp((local.y-desktop.Y)/(double)Math.Max(1,desktop.Height-1)),owner=arbiter.Allowed(Now(),true)?"available":"local"});}
        };timer.Start();
        if(!testing)Microsoft.Win32.SystemEvents.SessionSwitch+=SessionChanged;
        Shown+=(s,e)=>{if(readerStarted)return;readerStarted=true;Hide();Emit(new {type="ready",protocol=4,encoding="utf-8",version="2.4.0",dryRun=testing});var reader=new Thread(ReadLoop);reader.IsBackground=true;reader.Start();};
        FormClosing+=(s,e)=>{if(!testing)Microsoft.Win32.SystemEvents.SessionSwitch-=SessionChanged;Release();if(mouseHook!=IntPtr.Zero)UnhookWindowsHookEx(mouseHook);if(keyHook!=IntPtr.Zero)UnhookWindowsHookEx(keyHook);};
    }
    void SessionChanged(object sender,Microsoft.Win32.SessionSwitchEventArgs e){if(e.Reason==Microsoft.Win32.SessionSwitchReason.SessionLock||e.Reason==Microsoft.Win32.SessionSwitchReason.SessionLogoff){try{BeginInvoke((Action)(()=>Stop("session-locked")));}catch{}}}
    static double Clamp(double n){return Math.Max(0,Math.Min(1,n));}
    void ReadLoop(){
        string endReason="parent-exit";
        try{string line;while((line=commands.ReadLine())!=null){
            Dictionary<string,object> value;
            try{if(line.Length>4096)throw new ArgumentException();lock(Json){value=Json.Deserialize<Dictionary<string,object>>(line);}if(value==null||!value.ContainsKey("type")||!(value["type"] is string))throw new ArgumentException();}
            catch{Emit(new {type="protocol-error",reason="invalid-json"});BeginInvoke((Action)(()=>Stop("invalid-message")));continue;}
            BeginInvoke((Action)(()=>{try{Command(value);}catch{Emit(new {type="protocol-error",reason="invalid-command"});Stop("invalid-input");}}));
        }}catch(DecoderFallbackException){endReason="invalid-utf8";Emit(new {type="transport-error",reason=endReason});}
        catch(IOException){endReason="pipe-read-failed";Emit(new {type="transport-error",reason=endReason});}
        catch{endReason="reader-failed";Emit(new {type="transport-error",reason=endReason});}
        try{BeginInvoke((Action)(()=>{try{Stop(endReason);}finally{Close();}}));}catch{}
    }
    void Command(Dictionary<string,object> m){string type=Field(m,"type"),request=m.ContainsKey("request")?Field(m,"request"):null;
        if(type=="probe"&&testing){var names=new List<string>();var colors=new List<string>();foreach(var c in collaborators){names.Add(c.name);colors.Add(ColorTranslator.ToHtml(c.color));}Emit(new {type="probe",value=m.ContainsKey("value")?m["value"]:null,active=active,heldKeys=keys.Count,heldButtons=buttons.Count,inputEvents=testInputs.Count,pointerCount=collaborators.Count,names=names,colors=colors});return;}
        if(type=="grant"){
            Release();collaborators.Clear();desktop=new Rectangle((int)Num(m,"left"),(int)Num(m,"top"),(int)Num(m,"width"),(int)Num(m,"height"));if(desktop.Width<1||desktop.Height<1)return;
            Bounds=desktop;if(!testing)GetCursorPos(out local);systemPoint=local;physicalKeys.Clear();physicalButtons.Clear();remote=new POINT(desktop.Left+desktop.Width/2,desktop.Top+desktop.Height/2);localName=Field(m,"local");remoteName=Field(m,"remote");
            if(testing){pulse=Now();active=true;Emit(new {type="granted",request=request,dryRun=true,local=localName,remote=remoteName});return;}
            if(mouseHook==IntPtr.Zero)mouseHook=SetWindowsHookEx(14,mh,GetModuleHandle(null),0);
            if(keyHook==IntPtr.Zero)keyHook=SetWindowsHookEx(13,kh,GetModuleHandle(null),0);
            if(mouseHook==IntPtr.Zero||keyHook==IntPtr.Zero){Stop("hook-failed",request);return;}pulse=Now();active=true;Show();if(!SetWindowDisplayAffinity(Handle,0x11)){Stop("cursor-overlay-unsupported",request);return;}Emit(new {type="granted",request=request});return;
        }
        if(type=="stop"){Stop("revoked",request);return;}if(!active)return;
        if(type=="ping"){pulse=Now();return;}
        if(type=="cursors"){
            var list=new List<CoopPointer>();var values=m["participants"] as System.Collections.IEnumerable;if(values==null)throw new ArgumentException();
            foreach(object value in values){if(list.Count>=3)throw new ArgumentException();var p=value as Dictionary<string,object>;if(p==null)throw new ArgumentException();string color=Field(p,"color");if(color!="#ffac42"&&color!="#bf8bff"&&color!="#6cdd8b")throw new ArgumentException();double x=Num(p,"x"),y=Num(p,"y");if(double.IsNaN(x)||double.IsInfinity(x)||double.IsNaN(y)||double.IsInfinity(y))throw new ArgumentException();string name=Field(p,"name");list.Add(new CoopPointer{id=Field(p,"id"),name=name.Length>32?name.Substring(0,32):name,color=ColorTranslator.FromHtml(color),x=Clamp(x),y=Clamp(y)});}
            collaborators.Clear();collaborators.AddRange(list);return;
        }
        if(type=="release"){Release();return;}
        if(type=="move"||type=="button"||type=="wheel"){
            remote=new POINT(desktop.Left+(int)Math.Round(Clamp(Num(m,"x"))*(desktop.Width-1)),desktop.Top+(int)Math.Round(Clamp(Num(m,"y"))*(desktop.Height-1)));
            if(type=="move"){if(buttons.Count>0&&arbiter.Allowed(Now(),false))MovePointer(remote);return;}
            bool up=type=="button"&&Field(m,"action")=="up";
            if(!up&&(!arbiter.Allowed(Now(),false)||physicalKeys.Count>0||physicalButtons.Count>0)){Emit(new {type="busy",reason="local"});return;}
            if(type=="button"){
                int b=(int)Num(m,"button");if(b<0||b>2)return;
                if(up&&!buttons.Contains(b))return;
                MovePointer(remote);MouseButton(b,!up);if(up){buttons.Remove(b);if(buttons.Count==0){focusPending=true;focusAt=Now()+35;MovePointer(local);}}
                else{buttons.Add(b);remoteFocus=GetForegroundWindow();}
            }else{MovePointer(remote);Mouse(0x800,unchecked((uint)(int)Num(m,"delta")));MovePointer(local);}
            return;
        }
        if(type=="key"){
            int vk=(int)Num(m,"vk");bool down=Field(m,"action")=="down";if(vk<8||vk>254||vk==91||vk==92)return;
            if(!down){if(keys.Remove(vk))Key(vk,false);return;}
            if(!testing&&(!arbiter.Allowed(Now(),true)||physicalKeys.Count>0||physicalButtons.Count>0||remoteFocus==IntPtr.Zero||remoteFocus!=GetForegroundWindow())){Emit(new {type="busy",reason="focus"});return;}
            keys.Add(vk);Key(vk,true);
        }
    }
    void Stop(string reason,string request=null){if(ending)return;ending=true;Release();collaborators.Clear();active=false;Hide();if(mouseHook!=IntPtr.Zero){UnhookWindowsHookEx(mouseHook);mouseHook=IntPtr.Zero;}if(keyHook!=IntPtr.Zero){UnhookWindowsHookEx(keyHook);keyHook=IntPtr.Zero;}Emit(new {type="stopped",reason=reason,request=request});ending=false;}
    void Release(){focusPending=false;foreach(int vk in keys)Key(vk,false);keys.Clear();foreach(int b in buttons)MouseButton(b,false);buttons.Clear();remoteFocus=IntPtr.Zero;}
    IntPtr MouseHook(int code,IntPtr msg,IntPtr data){if(code>=0&&active){var m=(MOUSEHOOK)Marshal.PtrToStructure(data,typeof(MOUSEHOOK));if((m.flags&1)!=0)systemPoint=m.pt;else{
        int kind=(int)msg;bool takingOver=buttons.Count>0;
        if(kind==0x201||kind==0x204||kind==0x207)physicalButtons.Add(kind);if(kind==0x202)physicalButtons.Remove(0x201);if(kind==0x205)physicalButtons.Remove(0x204);if(kind==0x208)physicalButtons.Remove(0x207);
        if(takingOver){
            if(kind==0x200){local=new POINT(local.x+m.pt.x-systemPoint.x,local.y+m.pt.y-systemPoint.y);}
            arbiter.LocalMouse=Now();Release();MovePointer(local);
            if(kind==0x201)MouseButton(0,true);else if(kind==0x202)MouseButton(0,false);else if(kind==0x204)MouseButton(2,true);else if(kind==0x205)MouseButton(2,false);else if(kind==0x207)MouseButton(1,true);else if(kind==0x208)MouseButton(1,false);else if(kind==0x20a)Mouse(0x800,unchecked((uint)(short)(m.mouseData>>16)));
            Emit(new {type="busy",reason="local-takeover"});return new IntPtr(1);
        }
        local=m.pt;systemPoint=m.pt;if(kind!=0x200){arbiter.LocalMouse=Now();Release();}
    }}return CallNextHookEx(mouseHook,code,msg,data);}
    IntPtr KeyboardHook(int code,IntPtr msg,IntPtr data){if(code>=0&&active){var k=(KEYHOOK)Marshal.PtrToStructure(data,typeof(KEYHOOK));if((k.flags&0x10)==0){if((int)msg==0x100||(int)msg==0x104){physicalKeys.Add((int)k.vk);arbiter.LocalKeys=Now();IntPtr previousFocus=remoteFocus;Release();if(previousFocus!=IntPtr.Zero&&previousFocus==GetForegroundWindow())remoteFocus=previousFocus;}else if((int)msg==0x101||(int)msg==0x105)physicalKeys.Remove((int)k.vk);}}return CallNextHookEx(keyHook,code,msg,data);}
    static void MovePointer(POINT p){if(testing){testInputs.Add("move");return;}int x=GetSystemMetrics(76),y=GetSystemMetrics(77),w=GetSystemMetrics(78),h=GetSystemMetrics(79);Mouse(0x8000|0x4000|1,0,(int)Math.Round((p.x-x)*65535.0/Math.Max(1,w-1)),(int)Math.Round((p.y-y)*65535.0/Math.Max(1,h-1)));}
    static void MouseButton(int b,bool down){uint[] d={2,0x20,8},u={4,0x40,0x10};Mouse(down?d[b]:u[b],0);}
    static void Mouse(uint flags,uint value,int x=0,int y=0){if(testing){testInputs.Add("mouse:"+flags);return;}var input=new INPUT{type=0,data=new UNION{mouse=new MOUSEINPUT{dx=x,dy=y,flags=flags,mouseData=value}}};if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)Emit(new {type="blocked"});}
    static void Key(int vk,bool down){if(testing){testInputs.Add("key:"+vk+":"+down);return;}uint flags=down?0u:2u;if(vk>=33&&vk<=46||vk==163||vk==165||vk==111)flags|=1;var input=new INPUT{type=1,data=new UNION{key=new KEYINPUT{vk=(ushort)vk,flags=flags}}};if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)Emit(new {type="blocked"});}
    protected override void OnPaint(PaintEventArgs e){
        base.OnPaint(e);
        if(!active||collaborators.Count==0)return;
        DrawPointer(e.Graphics,local,Color.FromArgb(49,213,231),localName);
        foreach(var p in collaborators)DrawPointer(e.Graphics,new POINT(desktop.Left+(int)(p.x*(desktop.Width-1)),desktop.Top+(int)(p.y*(desktop.Height-1))),p.color,p.name);
    }
    void DrawPointer(Graphics g,POINT p,Color color,string label){int x=p.x-desktop.Left,y=p.y-desktop.Top;var pts=new[]{new Point(x,y),new Point(x+5,y+23),new Point(x+10,y+16),new Point(x+22,y+15)};using(var brush=new SolidBrush(color))using(var border=new Pen(Color.Black,2)){g.FillPolygon(brush,pts);g.DrawPolygon(border,pts);var text=label.Length>18?label.Substring(0,18):label;var size=g.MeasureString(text,Font);g.FillRectangle(Brushes.Black,x+18,y+20,size.Width+6,size.Height+4);g.DrawString(text,Font,brush,x+21,y+22);}}
    [STAThread]static void Main(string[] args){
        ConfigureTransport();
        if(args.Length==1&&args[0]=="--self-test"){
            testing=true;var a=new Arbitration();if(!a.Allowed(0,true))Environment.Exit(2);a.LocalKeys=100;if(a.Allowed(1299,true)||!a.Allowed(1300,true))Environment.Exit(3);a.LocalMouse=2000;if(a.Allowed(2299,false)||!a.Allowed(2300,false)||a.Allowed(2699,true)||!a.Allowed(2700,true))Environment.Exit(4);
            using(var f=new CoopInput()){f.keys.Add(65);f.keys.Add(162);f.buttons.Add(0);f.buttons.Add(2);f.Release();if(f.keys.Count!=0||f.buttons.Count!=0||testInputs.Count!=4||!testInputs.Contains("key:65:False")||!testInputs.Contains("key:162:False")||!testInputs.Contains("mouse:4")||!testInputs.Contains("mouse:16"))Environment.Exit(5);}
            Emit(new {passed=true,scope="Arbitration and key/button release through a dry-run input sink; no hooks or OS input injection",releaseEvents=testInputs.Count,inputSize=Marshal.SizeOf(typeof(INPUT))});return;
        }
        if(args.Length==1&&args[0]=="--ipc-test")testing=true;
        try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}Application.EnableVisualStyles();Application.Run(new CoopInput());
    }
}
