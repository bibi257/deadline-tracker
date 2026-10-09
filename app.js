(function(){
"use strict";

/* ========== 保存領域（localStorage が使えない環境ではメモリに退避） ========== */
var KEY="deadline-tracker-v1";
var mem={}, hasLS=false;
try{ localStorage.setItem("__t","1"); localStorage.removeItem("__t"); hasLS=true; }catch(e){ hasLS=false; }
var store={
  get:function(k){ return hasLS?localStorage.getItem(k):(k in mem?mem[k]:null); },
  set:function(k,v){ if(hasLS){try{localStorage.setItem(k,v);}catch(e){toast("保存できませんでした（空き容量を確認してください）");}} else {mem[k]=v;} }
};

/* ========== 秘密の保存（GitHubトークン・Discord の Webhook URL） ==========
   localStorage に平文では置かない。この端末のブラウザに「取り出せない鍵」（WebCrypto・extractable:false）を作って
   IndexedDB に置き、AES-GCM で暗号化した文字列（enc1:...）だけを localStorage に保存する。
   守れるもの：localStorage の中身だけが漏れた場合（端末のバックアップ・画面の写り込み・保存領域の抜き出しなど）。
   守れないもの：このページで動くスクリプト自体が乗っ取られた場合（鍵を使って復号できてしまう。そちらはCSPで防ぐ）。
   暗号化できない環境（IndexedDB/WebCrypto が使えない）では、平文で残さず「保存しない」ことにする。 */
var _secretCache={};   // 復号済みの値（このページを開いている間だけ。画面を閉じる直前の自動同期が間に合うように）
function _b64(buf){ var a=new Uint8Array(buf), s=""; for(var i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s); }
function _unb64(str){ var s=atob(str), a=new Uint8Array(s.length); for(var i=0;i<s.length;i++) a[i]=s.charCodeAt(i); return a; }
function _secretKey(){
  if(!(window.crypto&&crypto.subtle&&window.indexedDB)) return Promise.resolve(null);
  return new Promise(function(resolve){
    var req;
    try{ req=indexedDB.open("deadline-secret",1); }catch(e){ resolve(null); return; }
    req.onupgradeneeded=function(){ req.result.createObjectStore("keys"); };
    req.onerror=function(){ resolve(null); };
    req.onsuccess=function(){
      var idb=req.result;
      var done=function(k){ idb.close(); resolve(k||null); };
      try{
        var got=idb.transaction("keys").objectStore("keys").get("k");
        got.onerror=function(){ done(null); };
        got.onsuccess=function(){
          if(got.result) return done(got.result);
          crypto.subtle.generateKey({name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]).then(function(key){
            // 別のタブが先に作っていたらそちらを使う（二重に作ると、先に暗号化した値が読めなくなるため）
            var tx=idb.transaction("keys","readwrite"), os=tx.objectStore("keys"), again=os.get("k"), use=key;
            again.onsuccess=function(){ if(again.result) use=again.result; else os.put(key,"k"); };
            tx.oncomplete=function(){ done(use); };
            tx.onerror=tx.onabort=function(){ done(null); };
          }).catch(function(){ done(null); });
        };
      }catch(e){ done(null); }
    };
  });
}
/* name の値を暗号化して保存する。保存できたら true、できなければ false（平文では残さない） */
function secretSet(name, value){
  if(!value){ secretDel(name); return Promise.resolve(true); }
  _secretCache[name]=value;
  if(!hasLS){ store.set(name, value); return Promise.resolve(true); } // 保存領域が無い環境では、もともとメモリにしか残らない
  return _secretKey().then(function(key){
    if(!key) throw 0;
    var iv=crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({name:"AES-GCM",iv:iv}, key, new TextEncoder().encode(value)).then(function(ct){
      store.set(name, "enc1:"+_b64(iv)+":"+_b64(ct));
      return true;
    });
  }).catch(function(){ try{ localStorage.removeItem(name); }catch(e){} return false; });
}
function secretDel(name){
  delete _secretCache[name];
  if(hasLS){ try{ localStorage.removeItem(name); }catch(e){} } else { delete mem[name]; }
}
/* 保存してある値を返す（無ければ ""）。以前の版が平文で保存した値はそのまま使い、暗号化し直す */
function secretGet(name){
  if(_secretCache[name]) return Promise.resolve(_secretCache[name]);
  var raw=store.get(name);
  if(!raw) return Promise.resolve("");
  if(raw.indexOf("enc1:")!==0){
    _secretCache[name]=raw;
    if(hasLS) secretSet(name, raw).then(function(ok){ // 暗号化できればその場で置き換える。できなければ平文は残さず消す（今回の起動中は使える）
      if(!ok) toast("この端末では暗号化して保存できないため、保存してあったトークンを消しました。次回は入力し直してください");
    });
    return Promise.resolve(raw);
  }
  var parts=raw.split(":");
  return _secretKey().then(function(key){
    if(!key||parts.length!==3) throw 0;
    return crypto.subtle.decrypt({name:"AES-GCM",iv:_unb64(parts[1])}, key, _unb64(parts[2]));
  }).then(function(buf){
    var v=new TextDecoder().decode(buf);
    _secretCache[name]=v;
    return v;
  }).catch(function(){
    // 鍵が消えている（サイトデータの削除など）と復号できない。読めない値は残さず、入力し直してもらう
    secretDel(name);
    return "";
  });
}

var db={items:[],templates:[],trash:[],quarantine:[],completions:[],expCarry:0,categories:["仕事","提出物","支払い","プライベート","その他"],catReminders:{},catColors:Object.create(null),settings:{dayHour:9,theme:"auto"},updatedAt:null};
function load(){
  var raw=store.get(KEY); if(!raw) return;
  try{
    var d=JSON.parse(raw);
    // ここ(自分自身のlocalStorage)は検証しない。既存の表示が急に消えて驚かせないため。
    // 壊れたデータの検証は、外部由来のGitHubからの取り込み口(pullFromGitHub / autoPullIfStale)で行う
    if(d&&Array.isArray(d.items)) db.items=d.items;
    // templates は後から追加した項目。古いデータには無いので空配列で補う
    if(d&&Array.isArray(d.templates)) db.templates=d.templates;
    // trash も同様に後から追加した項目
    if(d&&Array.isArray(d.trash)) db.trash=d.trash;
    if(d&&Array.isArray(d.quarantine)) db.quarantine=d.quarantine;
    if(d&&Array.isArray(d.categories)&&d.categories.length) db.categories=d.categories;
    if(d) db.catReminders=cleanCatReminders(d.catReminders);
    if(d) db.catColors=cleanCatColors(d.catColors);
    if(d&&d.settings) db.settings=Object.assign(db.settings,d.settings);
    if(d&&d.updatedAt) db.updatedAt=d.updatedAt;
    if(d) adoptCompletions(d);
  }catch(e){}
  // 以前この端末だけに持っていた経験値(settings.exp)は、同期される記録へ移す
  if(db.settings.exp){ db.expCarry=(db.expCarry||0)+db.settings.exp; delete db.settings.exp; }
  // ゴミ箱は30日を過ぎたものと、上限(30件)を超えた古いものを読み込み時に整理する
  var cutoff=Date.now()-30*86400000;
  db.trash=db.trash.filter(function(t){ return new Date(t.deletedAt).getTime()>=cutoff; });
  if(db.trash.length>30) db.trash=db.trash.slice(db.trash.length-30);
  // trashIdが無い古い形式のエントリには後付けで振る(実装変更前のデータとの互換)
  db.trash.forEach(function(t){
    if(!t.trashId) t.trashId="tr"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  });
}
/* 通常の保存。呼ぶたびに「この端末で今変更した」時刻を刻む */
function save(){ db.updatedAt=new Date().toISOString(); store.set(KEY,JSON.stringify(db)); }
/* GitHubから受け取った内容をそのまま保存するとき用。
   updatedAtは呼び出し側でリモートの値に合わせてから使うため、ここでは上書きしない */
function saveRaw(){ store.set(KEY,JSON.stringify(db)); }

/* 完了の記録（いつ・締切の何時間前に終えたか・獲得EXP）。data.json に入れて端末間で同期し、
   週次レビューでまとめる。古い記録は上限を超えたら捨て、そのEXPだけ expCarry に繰り越す */
var COMPLETION_LIMIT=500;
function cleanCompletions(arr){
  return (Array.isArray(arr)?arr:[]).filter(function(c){
    return c && typeof c.id==="string" && !isNaN(new Date(c.doneAt).getTime());
  }).map(function(c){ var x=Object.assign({},c); x.exp=Math.max(0,Number(x.exp)||0); return x; });
}
function adoptCompletions(d){
  if(Array.isArray(d.completions)) db.completions=cleanCompletions(d.completions);
  if(typeof d.expCarry==="number" && d.expCarry>=0) db.expCarry=d.expCarry;
}
function trimCompletions(){
  while(db.completions.length>COMPLETION_LIMIT){
    var c=db.completions.shift();
    db.expCarry=(db.expCarry||0)+(c.exp||0);
  }
}
function totalExp(){
  return (db.expCarry||0)+db.completions.reduce(function(a,c){ return a+(c.exp||0); },0);
}

/* 取り込んだ項目を検証する。取り込み口(load/pullFromGitHub/autoPullIfStale)でのみ使う。
   必須(id・title・有効なdue)が壊れている項目は隔離し、それ以外の軽微な不正値は
   既定値に補正して使い続けられるようにする */
function sanitizeIncomingItems(rawItems){
  var kept=[], quarantined=[];
  (rawItems||[]).forEach(function(it){
    if(!it || typeof it!=="object"){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"項目の形式が不正", raw:it}); return; }
    if(typeof it.id!=="string" || !it.id){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"idが無い、または不正", raw:it}); return; }
    if(typeof it.title!=="string" || !it.title.trim()){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"タイトルが無い、または不正", raw:it}); return; }
    var due=new Date(it.due);
    if(isNaN(due.getTime())){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"締切日(due)が不正な日付：「"+it.due+"」", raw:it}); return; }
    // ここから先は軽微な不正。項目ごと隔離せず、既定値に補正して使う
    var fixed=Object.assign({}, it);
    if(fixed.start){
      var s=new Date(fixed.start);
      if(isNaN(s.getTime())) delete fixed.start; // 開始日が壊れていれば無かったことにする
    }
    if(fixed.rep && ["weekly","biweekly","monthly","yearly"].indexOf(fixed.rep)<0) fixed.rep="none";
    if(fixed.rep && fixed.rep!=="none" && typeof fixed.repCount!=="number") fixed.repCount=0;
    if(fixed.skip && !Array.isArray(fixed.skip)) delete fixed.skip;
    if(typeof fixed.done!=="boolean") fixed.done=!!fixed.done;
    kept.push(fixed);
  });
  return {kept:kept, quarantined:quarantined};
}
/* 取り込んだテンプレート・カテゴリの形を整える。名前が文字列でないものは捨てる
   （項目と同じく、壊れた値で候補や表示を崩さないため）。無ければ null を返す */
function sanitizeIncomingMeta(d){
  var out={templates:null, categories:null};
  if(Array.isArray(d.templates)) out.templates=d.templates.filter(function(t){ return t&&typeof t==="object"&&typeof t.name==="string"&&t.name; });
  if(Array.isArray(d.categories)){
    var cats=d.categories.filter(function(c){ return typeof c==="string"&&c.trim(); });
    if(cats.length) out.categories=cats;
  }
  return out;
}

/* ========== 日付ユーティリティ ========== */
function pad(n){ return (n<10?"0":"")+n; }
function toLocalISO(d){ return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
function parseItemDate(it){ return new Date(it.due); }
function startOfDay(d){ return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
function daysBetween(a,b){ return Math.round((startOfDay(b)-startOfDay(a))/86400000); }
var DOW=["日","月","火","水","木","金","土"];
/* 残り日数の基準になる日時。期間つきの予定は「開始日」までを数える */
function refDate(it){ return it.start?new Date(it.start):parseItemDate(it); }

function fmtDue(d,allDay){
  var s=(d.getMonth()+1)+"/"+d.getDate()+"（"+DOW[d.getDay()]+"）";
  return allDay?s:(s+" "+pad(d.getHours())+":"+pad(d.getMinutes()));
}
function statusOf(it){
  var now=new Date(), d=refDate(it);
  if(parseItemDate(it)<now) return "over"; // 終了済みかどうかは締切で判定する
  var n=daysBetween(now,d);
  if(n<=0) return "today";
  if(n<=3) return "soon";
  if(n<=7) return "near";
  return "far";
}
function remainText(it){
  var now=new Date(), d=refDate(it), due=parseItemDate(it);
  if(due<now){
    var od=daysBetween(due,now);
    return {n:od===0?"—":od, u:od===0?"期限切れ":"日 超過"};
  }
  var n=daysBetween(now,d);
  if(n<0) return {n:"—", u:"進行中"};  // 期間の途中
  if(n===0){
    if(it.allDay) return {n:"今日", u:it.start?"開始":"締切"};
    var h=Math.max(0,Math.floor((d-now)/3600000));
    return {n:h, u:"時間後・今日"};
  }
  return {n:n, u:it.start?"日後に開始":"日後"};
}

/* ========== 祝日 ==========
   出典：holiday_jp（内閣府「国民の祝日について」を元にしたデータ）
   最終更新：2026-08-20 ／ 収録範囲：2026〜2032年
   ※法改正や振替で変わることがある。収録範囲を過ぎたら更新すること（README参照） */
var HOLIDAYS={
  // 2026年
  "2026-01-01":"元日",
  "2026-01-12":"成人の日",
  "2026-02-11":"建国記念の日",
  "2026-02-23":"天皇誕生日",
  "2026-03-20":"春分の日",
  "2026-04-29":"昭和の日",
  "2026-05-03":"憲法記念日",
  "2026-05-04":"みどりの日",
  "2026-05-05":"こどもの日",
  "2026-05-06":"こどもの日 振替休日",
  "2026-07-20":"海の日",
  "2026-08-11":"山の日",
  "2026-09-21":"敬老の日",
  "2026-09-22":"休日",
  "2026-09-23":"秋分の日",
  "2026-10-12":"スポーツの日",
  "2026-11-03":"文化の日",
  "2026-11-23":"勤労感謝の日",

  // 2027年
  "2027-01-01":"元日",
  "2027-01-11":"成人の日",
  "2027-02-11":"建国記念の日",
  "2027-02-23":"天皇誕生日",
  "2027-03-21":"春分の日",
  "2027-03-22":"春分の日 振替休日",
  "2027-04-29":"昭和の日",
  "2027-05-03":"憲法記念日",
  "2027-05-04":"みどりの日",
  "2027-05-05":"こどもの日",
  "2027-07-19":"海の日",
  "2027-08-11":"山の日",
  "2027-09-20":"敬老の日",
  "2027-09-23":"秋分の日",
  "2027-10-11":"スポーツの日",
  "2027-11-03":"文化の日",
  "2027-11-23":"勤労感謝の日",

  // 2028年
  "2028-01-01":"元日",
  "2028-01-10":"成人の日",
  "2028-02-11":"建国記念の日",
  "2028-02-23":"天皇誕生日",
  "2028-03-20":"春分の日",
  "2028-04-29":"昭和の日",
  "2028-05-03":"憲法記念日",
  "2028-05-04":"みどりの日",
  "2028-05-05":"こどもの日",
  "2028-07-17":"海の日",
  "2028-08-11":"山の日",
  "2028-09-18":"敬老の日",
  "2028-09-22":"秋分の日",
  "2028-10-09":"スポーツの日",
  "2028-11-03":"文化の日",
  "2028-11-23":"勤労感謝の日",

  // 2029年
  "2029-01-01":"元日",
  "2029-01-08":"成人の日",
  "2029-02-11":"建国記念の日",
  "2029-02-12":"建国記念の日 振替休日",
  "2029-02-23":"天皇誕生日",
  "2029-03-20":"春分の日",
  "2029-04-29":"昭和の日",
  "2029-04-30":"昭和の日 振替休日",
  "2029-05-03":"憲法記念日",
  "2029-05-04":"みどりの日",
  "2029-05-05":"こどもの日",
  "2029-07-16":"海の日",
  "2029-08-11":"山の日",
  "2029-09-17":"敬老の日",
  "2029-09-23":"秋分の日",
  "2029-09-24":"秋分の日 振替休日",
  "2029-10-08":"スポーツの日",
  "2029-11-03":"文化の日",
  "2029-11-23":"勤労感謝の日",

  // 2030年
  "2030-01-01":"元日",
  "2030-01-14":"成人の日",
  "2030-02-11":"建国記念の日",
  "2030-02-23":"天皇誕生日",
  "2030-03-20":"春分の日",
  "2030-04-29":"昭和の日",
  "2030-05-03":"憲法記念日",
  "2030-05-04":"みどりの日",
  "2030-05-05":"こどもの日",
  "2030-05-06":"こどもの日 振替休日",
  "2030-07-15":"海の日",
  "2030-08-11":"山の日",
  "2030-08-12":"山の日 振替休日",
  "2030-09-16":"敬老の日",
  "2030-09-23":"秋分の日",
  "2030-10-14":"スポーツの日",
  "2030-11-03":"文化の日",
  "2030-11-04":"文化の日 振替休日",
  "2030-11-23":"勤労感謝の日",

  // 2031年
  "2031-01-01":"元日",
  "2031-01-13":"成人の日",
  "2031-02-11":"建国記念の日",
  "2031-02-23":"天皇誕生日",
  "2031-02-24":"天皇誕生日 振替休日",
  "2031-03-21":"春分の日",
  "2031-04-29":"昭和の日",
  "2031-05-03":"憲法記念日",
  "2031-05-04":"みどりの日",
  "2031-05-05":"こどもの日",
  "2031-05-06":"こどもの日 振替休日",
  "2031-07-21":"海の日",
  "2031-08-11":"山の日",
  "2031-09-15":"敬老の日",
  "2031-09-23":"秋分の日",
  "2031-10-13":"スポーツの日",
  "2031-11-03":"文化の日",
  "2031-11-23":"勤労感謝の日",
  "2031-11-24":"勤労感謝の日 振替休日",

  // 2032年
  "2032-01-01":"元日",
  "2032-01-12":"成人の日",
  "2032-02-11":"建国記念の日",
  "2032-02-23":"天皇誕生日",
  "2032-03-20":"春分の日",
  "2032-04-29":"昭和の日",
  "2032-05-03":"憲法記念日",
  "2032-05-04":"みどりの日",
  "2032-05-05":"こどもの日",
  "2032-07-19":"海の日",
  "2032-08-11":"山の日",
  "2032-09-20":"敬老の日",
  "2032-09-21":"休日",
  "2032-09-22":"秋分の日",
  "2032-10-11":"スポーツの日",
  "2032-11-03":"文化の日",
  "2032-11-23":"勤労感謝の日"
};
function holidayName(key){ return HOLIDAYS[key]||null; }
function isHoliday(d){ return !!HOLIDAYS[toLocalISO(d)]; }
/* 土日祝のいずれかなら休日とみなす */
function isDayOff(d){ return d.getDay()===0||d.getDay()===6||isHoliday(d); }

/* ========== .ics 生成 ========== */
function esc(s){ return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n"); }
function utc(d){
  return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+"T"+
         pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+"Z";
}
function dateOnly(d){ return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate()); }
function fold(line){ // RFC5545: 1行75オクテット以内。日本語があるのでバイト数で折る
  var out="", cur="", b=0;
  for(var i=0;i<line.length;i++){
    var cp=line.codePointAt(i), ch=line[i];
    if(cp>0xFFFF){ ch=line.substr(i,2); i++; }
    var n = cp<0x80?1 : cp<0x800?2 : cp<0x10000?3 : 4;
    if(b+n>72){ out+=cur+"\r\n "; cur=""; b=0; }
    cur+=ch; b+=n;
  }
  return out+cur;
}
function alarm(trigger,label){
  return ["BEGIN:VALARM","ACTION:DISPLAY","DESCRIPTION:"+esc(label),
          "TRIGGER;VALUE=DATE-TIME:"+utc(trigger),"END:VALARM"];
}
/* 繰り返し予定用。絶対時刻だと初回しか鳴らないので、相対時間で指定する。
   期間ありの予定は終了(=締切)基準、期間なしは開始(=締切)基準にする */
function relAlarm(minutesBefore,label,relatedEnd){
  return ["BEGIN:VALARM","ACTION:DISPLAY","DESCRIPTION:"+esc(label),
          "TRIGGER"+(relatedEnd?";RELATED=END":"")+":-PT"+minutesBefore+"M","END:VALARM"];
}
function veventOf(it){
  var due=parseItemDate(it);
  var begin=it.start?new Date(it.start):new Date(due.getTime()-30*60000);
  var end=due;
  var L=["BEGIN:VEVENT",
    "UID:"+it.id+"@deadline-tracker",
    "DTSTAMP:"+utc(new Date()),
    "SEQUENCE:"+(it.seq||0)];
  if(it.allDay){
    // 終日予定。DTENDは翌日を指す決まりなので1日足す
    var s=it.start?new Date(it.start):due;
    var e=new Date(due.getFullYear(),due.getMonth(),due.getDate()+1);
    L.push("DTSTART;VALUE=DATE:"+dateOnly(s));
    L.push("DTEND;VALUE=DATE:"+dateOnly(e));
  } else {
    L.push("DTSTART:"+utc(begin));
    L.push("DTEND:"+utc(end));
  }
  L.push("SUMMARY:"+esc(it.title));
  L.push("CATEGORIES:"+esc(it.cat||"その他"));
  if(it.memo) L.push("DESCRIPTION:"+esc(it.memo));
  var repeating=!!(it.rep&&it.rep!=="none");
  if(repeating){
    var freq={weekly:"FREQ=WEEKLY",biweekly:"FREQ=WEEKLY;INTERVAL=2",monthly:"FREQ=MONTHLY",yearly:"FREQ=YEARLY"}[it.rep];
    if(freq) L.push("RRULE:"+freq+monthEndRule(it, due, begin)+(it.repCount>0?";COUNT="+it.repCount:""));
    // 取りやめた回はEXDATEで除外する。skipのキーは各回の「締切日」だが、
    // EXDATEは各回のDTSTARTと一致させる必要があるため、開始までの差だけずらす
    if(it.skip&&it.skip.length){
      it.skip.forEach(function(k){
        var parts=k.split("-");
        var exDue=new Date(+parts[0],+parts[1]-1,+parts[2],due.getHours(),due.getMinutes(),0);
        if(isNaN(exDue.getTime())) return;
        if(it.allDay){
          var s0=it.start?new Date(it.start):due;
          var dayGap=daysBetween(s0,due);
          L.push("EXDATE;VALUE=DATE:"+dateOnly(new Date(exDue.getFullYear(),exDue.getMonth(),exDue.getDate()-dayGap)));
        } else {
          L.push("EXDATE:"+utc(new Date(exDue.getTime()-(end-begin))));
        }
      });
    }
  }

  // 通知はカテゴリごとの設定（何日前に知らせるか）に従う。
  // N日前の通知は締切と同じ時刻、当日の通知は「当日リマインドの時刻」に鳴る
  var days=remindersFor(it.cat);
  if(repeating){
    // 毎回鳴らすため相対時間で指定する。締切＝予定の終了なので終了基準に揃える。
    // 終日予定の終了(DTEND)は翌日0時なので、締切(23:59)との差を足して
    // 繰り返しでない予定と同じ時刻に鳴るようにする
    var gap=it.allDay?Math.round((new Date(due.getFullYear(),due.getMonth(),due.getDate()+1)-due)/60000):0;
    days.forEach(function(n){
      if(n>0){ L=L.concat(relAlarm(n*24*60+gap, it.title+"："+reminderLabel(n), true)); return; }
      var minsFrom9=(due.getHours()-db.settings.dayHour)*60+due.getMinutes();
      if(minsFrom9>0) L=L.concat(relAlarm(minsFrom9+gap, it.title+"："+reminderLabel(0), true));
    });
  } else {
    days.forEach(function(n){
      if(n>0){ L=L.concat(alarm(new Date(due.getTime()-n*86400000), it.title+"："+reminderLabel(n))); return; }
      var dayOf=new Date(due.getFullYear(),due.getMonth(),due.getDate(),db.settings.dayHour,0,0);
      if(dayOf<due) L=L.concat(alarm(dayOf, it.title+"："+reminderLabel(0)));
    });
  }
  L.push("END:VEVENT");
  return L;
}
/* ========== カテゴリごとの通知（案F） ==========
   catReminders は { "カテゴリ名": [7,1,0] } の形で「何日前に知らせるか」を持つ（0は当日）。
   categories（文字列の配列）とは別の項目にして、古い版のアプリでも壊れないようにしている */
var REMINDER_DEFAULT=[7,1,0];
var REMINDER_CHOICES=[14,7,3,2,1,0];
function remindersFor(cat){
  var v=db.catReminders[cat||"その他"];
  return Array.isArray(v)?v:REMINDER_DEFAULT;
}
function reminderLabel(n){
  if(n===0) return "今日が締切";
  if(n===1) return "明日が締切";
  if(n%7===0) return "あと"+(n/7)+"週間";
  return "あと"+n+"日";
}
/* 外から来た値（GitHub・JSON）を検証する。壊れた値は捨てて既定に戻す */
function cleanCatReminders(v){
  var out={};
  if(!v || typeof v!=="object" || Array.isArray(v)) return out;
  Object.keys(v).forEach(function(k){
    if(!Array.isArray(v[k])) return;
    var arr=v[k].filter(function(n){ return typeof n==="number" && n>=0 && n<=60 && Math.floor(n)===n; });
    arr=arr.filter(function(n,i){ return arr.indexOf(n)===i; }).sort(function(a,b){ return b-a; });
    out[k]=arr;
  });
  return out;
}

function buildICS(items){
  var L=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//deadline-tracker//JP","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
  items.forEach(function(it){ L=L.concat(veventOf(it)); });
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n")+"\r\n";
}
function downloadICS(items,name){
  if(!items.length){ toast("書き出す締切がありません"); return; }
  var blob=new Blob([buildICS(items)],{type:"text/calendar;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url; a.download=(name||"deadlines").replace(/[\\/:*?"<>|]/g,"_")+".ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); },1500);
  toast("カレンダーファイルを書き出しました");
}

/* ========== 状態 ========== */
var view="list", filter="ALL", calRef=new Date(), selDay=null, editingId=null, searchKw="";
var main=document.getElementById("main");

function activeItems(){ return db.items.filter(function(i){ return !i.done; }); }
/* 並び順。期間つきの予定は「開始日」を基準にして、
   カードに出ている残り日数と並びが食い違わないようにする */
function sortByDue(a,b){
  var d=refDate(a)-refDate(b);
  return d!==0?d:(parseItemDate(a)-parseItemDate(b));
}

function h(html){ var t=document.createElement("template"); t.innerHTML=html.trim(); return t.content.firstElementChild; }
function escHtml(s){ return String(s).replace(/[&<>"]/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

/* ========== 描画 ========== */
var _lastTabView=null;
function render(){
  resetColorCache();
  var now=new Date();
  document.getElementById("todayLabel").textContent =
    now.getFullYear()+"年"+(now.getMonth()+1)+"月"+now.getDate()+"日（"+DOW[now.getDay()]+"）";
  // ヘッダーの「7日以内」は締切のみを数える（定期予定は常時あるため除く）。
  // 期限切れには、完了にし忘れた定期予定も含める（自動完了のものは期限を過ぎると次回へ進むので入らない）
  var onceOnly=activeItems().filter(function(i){ return !isRepeating(i); });
  var soon=onceOnly.filter(function(i){ var d=refDate(i); return parseItemDate(i)>=now && daysBetween(now,d)<=7; });
  var over=activeItems().filter(function(i){ return parseItemDate(i)<now; });
  if(view==="rep"){
    var reps=activeItems().filter(isRepeating);
    document.getElementById("cntNum").textContent=reps.length;
    document.getElementById("cntLabel").textContent="定期予定";
  }
  else if(view==="over"){
    document.getElementById("cntNum").textContent=over.length;
    document.getElementById("cntLabel").textContent="超過";
  }
  else if(over.length){ document.getElementById("cntNum").textContent=over.length; document.getElementById("cntLabel").textContent="期限切れ"; }
  else { document.getElementById("cntNum").textContent=soon.length; document.getElementById("cntLabel").textContent="7日以内"; }
  document.body.setAttribute("data-view", view);
  renderLevelBar();
  document.documentElement.classList.toggle("no-motion", !motionOn());
  setTimeout(countUpSummary, 0);

  var tabView=(view==="day")?"week":view; // 日表示は今週タブの一部として扱う
  var tabsChanged=(tabView!==_lastTabView);
  document.querySelectorAll(".tab").forEach(function(t){
    t.setAttribute("aria-selected", t.dataset.view===tabView?"true":"false");
    // 1行で横に流すタブなので、切り替えた時だけ選んだタブが見える位置へ寄せる
    if(t.dataset.view===tabView && tabView!==_lastTabView && t.parentNode.scrollWidth>t.parentNode.clientWidth){
      var bar=t.parentNode, l=t.offsetLeft-bar.offsetLeft, r=l+t.offsetWidth;
      if(l<bar.scrollLeft || r>bar.scrollLeft+bar.clientWidth-24) bar.scrollLeft=Math.max(0,l-bar.clientWidth/2+t.offsetWidth/2);
    }
  });
  if(tabsChanged) _lastTabView=tabView;
  if(_tabsScroller) requestAnimationFrame(_tabsScroller.update);
  // 超過タブには件数を出し、開かなくても気づけるようにする
  var overTab=document.querySelector('.tab[data-view="over"]');
  if(overTab){
    var n=over.length;
    overTab.innerHTML="超過"+(n?'<span class="tab-badge">'+n+"</span>":"");
  }
  document.getElementById("fabAdd").style.display = (view==="set")?"none":"";

  main.innerHTML="";
  if(!hasLS) main.appendChild(h('<div class="notice">この画面ではブラウザの保存領域が使えないため、入力内容は再読み込みで消えます。GitHub Pages に置けば端末内に保存されます。</div>'));
  if(view==="list") renderList();
  else if(view==="week") renderWeek();
  else if(view==="day") renderDay();
  else if(view==="over") renderOverdue();
  else if(view==="rep") renderRepeat();
  else if(view==="cal") renderCal();
  else if(view==="done") renderDone();
  else renderSettings();
}

/* カテゴリの絞り込み。数が多くて画面に収まらないときは横に動かせる（スワイプ・ホイール・ドラッグ・‹ ›）。
   描き直しても前の位置を保ち、選んでいるカテゴリが見える位置に寄せる */
var _filterScrollLeft=0;
function filterBar(){
  var bar=h('<div class="filters"></div>');
  var cats=["ALL"].concat(db.categories);
  cats.forEach(function(c){
    var b=h('<button class="chip">'+(c==="ALL"?"":swatch(catColor(c)))+escHtml(c==="ALL"?"すべて":c)+'</button>');
    b.setAttribute("aria-pressed", filter===c?"true":"false");
    b.onclick=function(){ filter=c; render(); };
    bar.appendChild(b);
  });
  bar.addEventListener("scroll",function(){ _filterScrollLeft=bar.scrollLeft; },{passive:true});
  var wrap=makeHScroll(bar);
  requestAnimationFrame(function(){
    bar.scrollLeft=_filterScrollLeft;
    var sel=bar.querySelector('[aria-pressed="true"]');
    if(sel){
      var l=sel.offsetLeft-bar.offsetLeft, r=l+sel.offsetWidth;
      if(l<bar.scrollLeft+16) bar.scrollLeft=Math.max(0,l-40);
      else if(r>bar.scrollLeft+bar.clientWidth-16) bar.scrollLeft=r-bar.clientWidth+40;
    }
    wrap.update();
  });
  return wrap;
}

/* 横に並ぶ列（カテゴリ・タブ）を、パソコンでも動かせるようにする。
   ・マウスホイール（縦回し）で横に動く
   ・マウスでつかんで左右にドラッグできる（ドラッグした直後のクリックは押さないことにする）
   ・端に ‹ › ボタンを出す（その向きにまだ続きがあるときだけ） */
/* ドラッグ中の列と、画面幅の変化への対応は1か所でまとめて扱う（列を作り直すたびに増やさない） */
var _hsDrag=null;
window.addEventListener("pointermove", function(e){
  var d=_hsDrag; if(!d) return;
  if(e.buttons===0){ endHsDrag(); return; } // ウィンドウの外でボタンを離した場合

  var dx=e.clientX-d.x;
  if(!d.moved && Math.abs(dx)>5){ d.moved=true; d.wrap.classList.add("dragging"); }
  if(d.moved) d.inner.scrollLeft=d.left-dx;
});
function endHsDrag(){
  var d=_hsDrag; if(!d) return; _hsDrag=null;
  if(d.moved){ d.wrap._justDragged=true; setTimeout(function(){ d.wrap.classList.remove("dragging"); d.wrap._justDragged=false; },0); }
}
window.addEventListener("pointerup", endHsDrag);
window.addEventListener("pointercancel", endHsDrag);
window.addEventListener("blur", endHsDrag);
window.addEventListener("resize", function(){ document.querySelectorAll(".hscroll").forEach(function(w){ if(w.update) w.update(); }); });
function makeHScroll(inner){
  var wrap=document.createElement("div");
  wrap.className="hscroll";
  if(inner.parentNode) inner.parentNode.replaceChild(wrap, inner);
  var prev=h('<button type="button" class="hs-btn hs-prev" aria-label="左へ" tabindex="-1">‹</button>');
  var next=h('<button type="button" class="hs-btn hs-next" aria-label="右へ" tabindex="-1">›</button>');
  wrap.append(prev, inner, next);
  function max(){ return inner.scrollWidth-inner.clientWidth; }
  function update(){
    var m=max();
    wrap.classList.toggle("can-l", m>1 && inner.scrollLeft>2);
    wrap.classList.toggle("can-r", m>1 && inner.scrollLeft<m-2);
  }
  function step(dir){ inner.scrollBy({left:dir*Math.max(120,inner.clientWidth*0.7), behavior:motionOn()?"smooth":"auto"}); }
  prev.onclick=function(){ step(-1); };
  next.onclick=function(){ step(1); };
  inner.addEventListener("scroll", update, {passive:true});
  inner.addEventListener("wheel", function(e){
    if(max()<=1 || Math.abs(e.deltaX)>Math.abs(e.deltaY)) return; // 横スクロールはそのまま任せる
    var before=inner.scrollLeft;
    inner.scrollLeft+=e.deltaY;
    if(inner.scrollLeft!==before) e.preventDefault(); // 端まで来たらページの縦スクロールに戻す
  }, {passive:false});
  inner.addEventListener("pointerdown", function(e){
    if(e.pointerType!=="mouse" || e.button!==0 || max()<=1) return;
    _hsDrag={wrap:wrap, inner:inner, x:e.clientX, left:inner.scrollLeft, moved:false};
  });
  inner.addEventListener("click", function(e){ if(wrap._justDragged){ e.stopPropagation(); e.preventDefault(); wrap._justDragged=false; } }, true);
  wrap.update=update;
  requestAnimationFrame(update);
  return wrap;
}

/* ========== カテゴリの色 ==========
   36色（12色相 × 濃・中・淡）のテンプレート。指定が無いカテゴリには、並び順に「中」の色を
   見分けやすい順番で自動で割り振る（色覚の違いでも隣同士が区別しやすいよう検証済みの順）。
   手動で選んだ色は catColors に保存して同期する。締切ごとに個別の色（it.color）も持てる */
var CAT_PALETTE=["#7E2A31","#7E492A","#7E622A","#7E772A","#5B7E2A","#2A7E3F","#1D8B6F","#1D798B","#2A547E","#2A357E","#492A7E","#7E2A7E","#B2343E","#B26234","#B28834","#B2A734","#7DB234","#34B253","#22C39B","#22A8C3","#3473B2","#3444B2","#6234B2","#B234B2","#CD7A81","#CD987A","#CDB17A","#CDC67A","#AACD7A","#7ACD8F","#6CDABF","#6CC8DA","#7AA3CD","#7A85CD","#987ACD","#CD7ACD"];
var CAT_HUES=["赤","朱","橙","黄土","若草","緑","青緑","水","青","藍","紫","桃"];
var AUTO_ORDER=[0,6,10,3,8,1,9,5,11,2,7,4];
var AUTO_SEQ=[1,0,2].reduce(function(a,tone){ return a.concat(AUTO_ORDER.map(function(h){ return tone*12+h; })); },[]);
function normHex(v){
  v=String(v||"").trim(); if(v.charAt(0)!=="#") v="#"+v;
  if(/^#[0-9a-fA-F]{3}$/.test(v)) v="#"+v.charAt(1)+v.charAt(1)+v.charAt(2)+v.charAt(2)+v.charAt(3)+v.charAt(3);
  return /^#[0-9a-fA-F]{6}$/.test(v)?v.toUpperCase():null;
}
function cleanCatColors(o){
  // 名前が "toString" などでも Object の既定の関数を拾わないよう、プロトタイプの無い入れ物にする
  var out=Object.create(null); if(!o||typeof o!=="object") return out;
  Object.keys(o).forEach(function(k){ var h=normHex(o[k]); if(h) out[k]=h; });
  return out;
}
/* 自動の割り振り。手動で使われている色は飛ばして、カテゴリの並び順に配る */
/* 10: 毎回の色の問い合わせで作り直さないよう、描き直し（render）ごとに1回だけ計算する */
var _autoCache={map:null};
function resetColorCache(){ _autoCache.map=null; }
function autoColorMap(){
  if(_autoCache.map) return _autoCache.map;
  var used=Object.create(null); Object.keys(db.catColors).forEach(function(k){ used[db.catColors[k]]=1; });
  var map=Object.create(null), i=0;
  db.categories.forEach(function(c){
    if(db.catColors[c]) return;
    var guard=0;
    while(used[CAT_PALETTE[AUTO_SEQ[i%36]]] && guard++<36) i++;
    map[c]=CAT_PALETTE[AUTO_SEQ[i%36]]; used[map[c]]=1; i++;
  });
  _autoCache.map=map;
  return map;
}
function catColorRaw(cat){
  cat=cat||"その他";
  return db.catColors[cat] || autoColorMap()[cat] || "#8E8B80"; // 一覧に無いカテゴリは灰
}
function itemColorRaw(it){ return normHex(it.color) || catColorRaw(it.cat); }

/* ダークモードでは、色相は保ったまま暗い背景で読める明るさ・鮮やかさに直して表示する
   （OKLCHで明るさを 0.50〜0.665 に写す。相対的な明暗差は残すので色同士の見分けも保つ） */
function isDarkTheme(){ return document.documentElement.getAttribute("data-theme")==="dark"; }
var _darkCache={};
function displayColor(hex){
  if(!isDarkTheme()) return hex;
  if(_darkCache[hex]) return _darkCache[hex];
  function s2l(c){ return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4); }
  function l2s(c){ c=Math.max(0,Math.min(1,c)); return c<=0.0031308?12.92*c:1.055*Math.pow(c,1/2.4)-0.055; }
  function toLab(h){
    var r=s2l(parseInt(h.substr(1,2),16)/255), g=s2l(parseInt(h.substr(3,2),16)/255), b=s2l(parseInt(h.substr(5,2),16)/255);
    var l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b), m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b), q=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
    return [0.2104542553*l+0.7936177850*m-0.0040720468*q, 1.9779984951*l-2.4285922050*m+0.4505937099*q, 0.0259040371*l+0.7827717662*m-0.8086757660*q];
  }
  function fromLab(L,a,b){
    var l=Math.pow(L+0.3963377774*a+0.2158037573*b,3), m=Math.pow(L-0.1055613458*a-0.0638541728*b,3), q=Math.pow(L-0.0894841775*a-1.2914855480*b,3);
    var rgb=[4.0767416621*l-3.3077115913*m+0.2309699292*q, -1.2684380046*l+2.6097574011*m-0.3413193965*q, -0.0041960863*l-0.7034186147*m+1.7076147010*q];
    return "#"+rgb.map(function(x){ var v=Math.round(l2s(x)*255).toString(16).toUpperCase(); return v.length<2?"0"+v:v; }).join("");
  }
  var lab=toLab(hex), C=Math.hypot(lab[1],lab[2]), H=Math.atan2(lab[2],lab[1]);
  var L=0.5+(Math.min(0.85,Math.max(0.3,lab[0]))-0.3)/0.55*0.165;
  C=Math.max(C,0.11);
  var out=hex;
  for(var k=0;k<20;k++){ // 色域外なら彩度を下げて戻す
    out=fromLab(L,C*Math.cos(H),C*Math.sin(H));
    var back=toLab(out); if(Math.abs(Math.hypot(back[1],back[2])-C)<0.01) break; C*=0.95;
  }
  return (_darkCache[hex]=out);
}
function catColor(cat){ return displayColor(catColorRaw(cat)); }
function itemColor(it){ return displayColor(itemColorRaw(it)); }
function swatch(color, title){ return '<i class="sw" style="background:'+color+'"'+(title?' title="'+escHtml(title)+'"':'')+' aria-hidden="true"></i>'; }

/* 色の選択部品（36色・カラーコード・自動に戻す）。value は保存値（null＝自動） */
function colorPicker(opts){
  var el=h('<div class="cpick"><button type="button" class="cp-cur"></button><div class="cp-panel" hidden>'+
    '<div class="cp-grid"></div>'+
    '<div class="cp-row"><input type="color" class="cp-native" aria-label="色を選ぶ"><input type="text" class="cp-hex" maxlength="7" placeholder="#RRGGBB" aria-label="カラーコード" autocomplete="off" spellcheck="false">'+
    '<button type="button" class="act cp-apply">決定</button><button type="button" class="act cp-auto">'+escHtml(opts.autoLabel||"自動に戻す")+'</button></div></div></div>');
  var cur=el.querySelector(".cp-cur"), panel=el.querySelector(".cp-panel"), grid=el.querySelector(".cp-grid");
  var hexIn=el.querySelector(".cp-hex"), nat=el.querySelector(".cp-native");
  var value=normHex(opts.value);
  function paint(){
    var raw=value||opts.autoColor();
    cur.innerHTML=swatch(displayColor(raw))+'<span>'+(value?escHtml(value):escHtml(opts.autoText||"自動"))+'</span>';
    hexIn.value=value||""; nat.value=(value||raw).toLowerCase();
    grid.querySelectorAll("button").forEach(function(b){ b.setAttribute("aria-pressed", b.getAttribute("data-c")===value?"true":"false"); });
  }
  CAT_PALETTE.forEach(function(c,i){
    var b=h('<button type="button" class="cp-sw" data-c="'+c+'" title="'+CAT_HUES[i%12]+"（"+["濃","中","淡"][Math.floor(i/12)]+"） "+c+'" style="background:'+displayColor(c)+'"></button>');
    b.onclick=function(){ set(c); };
    grid.appendChild(b);
  });
  function set(v){ value=v; paint(); opts.onChange(v); }
  cur.onclick=function(){ panel.hidden=!panel.hidden; };
  nat.oninput=function(){ hexIn.value=nat.value.toUpperCase(); };
  nat.onchange=function(){ set(normHex(nat.value)); };
  el.querySelector(".cp-apply").onclick=function(){
    var v=normHex(hexIn.value);
    if(!v){ toast("カラーコードは #RRGGBB の形で入力してください（例：#2A7E69）"); hexIn.focus(); return; }
    set(v);
  };
  hexIn.onkeydown=function(e){ if(e.key==="Enter"){ e.preventDefault(); el.querySelector(".cp-apply").click(); } };
  el.querySelector(".cp-auto").onclick=function(){ set(null); };
  el.refresh=paint;
  el.setValue=function(v){ value=normHex(v)||null; paint(); };
  paint();
  return el;
}

/* カードの見た目に使う状態。完了したものは状態色を付けず、
   期間の途中にある予定は「進行中」として締切までの近さで色を決める */
function cardStateOf(it){
  if(it.done) return {cls:"done", badge:["✓","完了","ok"]};
  var now=new Date(), due=parseItemDate(it);
  var ongoing=!!(it.start && new Date(it.start)<=now && due>=now);
  var st;
  if(due<now) st="over";
  else {
    var n=daysBetween(now, ongoing?due:refDate(it));
    st=n<=0?"today":n<=3?"soon":n<=7?"near":"far";
  }
  var labels={over:["!","期限切れ"],today:["●","今日"],soon:["▲","3日以内"],near:["◆","7日以内"]};
  var badge=ongoing?["→","進行中","st"]:(labels[st]?labels[st].concat("st"):null);
  return {cls:st, badge:badge};
}
function cardOf(it){
  var cs=cardStateOf(it), st=cs.cls, r=remainText(it), d=parseItemDate(it);
  var created=it.created?new Date(it.created):new Date(d.getTime()-14*86400000);
  var total=Math.max(1, d-created), pass=Math.min(total, Math.max(0, Date.now()-created));
  var pct=it.done?100:Math.round(pass/total*100);
  // カレンダー画面の繰り返しは表示用の複製（occurrence>0、または展開由来）で、
  // 完了・編集をここから行うと元の予定がずれるので、その回の取りやめだけに絞る
  var isCopy=!!it.isExpanded;
  // 状態は色だけに頼らず、記号と文字の判子でも示す（色覚の違いや印刷でも区別できるように）
  var badge=cs.badge;
  var isWord=(typeof r.n!=="number");
  var el=h('<article class="card '+st+(isRepeating(it)&&!it.done?" routine":"")+(isStale(it)&&!it.done?" stale":"")+'" data-id="'+escHtml(it.id)+'">'+
    '<div class="left"><b class="n num'+(isWord?" word":"")+'">'+escHtml(r.n)+'</b><span class="u">'+escHtml(r.u)+'</span></div>'+
    '<div class="body">'+
      '<h3 class="title">'+escHtml(it.title)+'</h3>'+
      '<div class="meta">'+(badge?'<span class="badge '+badge[2]+'"><i aria-hidden="true">'+badge[0]+'</i>'+badge[1]+'</span>':'')+
      (isRepeating(it)&&!it.done?'<span class="badge rt"><i aria-hidden="true">↻</i>定期</span>':'')+
      '<span class="cat catg">'+swatch(itemColor(it))+escHtml(it.cat||"その他")+'</span><span class="num">'+
      escHtml(it.start?(fmtDue(new Date(it.start),it.allDay)+" 〜 "+fmtDue(d,it.allDay)):fmtDue(d,it.allDay))+'</span>'+
      (it.allDay?'<span class="cat">終日</span>':"")+
      (it.autoComplete?'<span class="cat">自動完了</span>':"")+
      (isRepeating(it)&&it.calHide?'<span class="cat">カレンダー非表示</span>':"")+
      (it.rep&&it.rep!=="none"?'<span class="cat">'+({weekly:"毎週",biweekly:"隔週",monthly:"毎月",yearly:"毎年"}[it.rep])+
        (it.repCount>0?" 残"+it.repCount+"回":"")+'</span>':"")+'</div>'+
      (it.memo?'<p class="memo">'+escHtml(it.memo)+'</p>':"")+
      (isStale(it)&&!it.done?'<p class="stale-note">⚠️ '+overdueDays(it)+'日が過ぎています。まだ必要ですか？完了か削除をおすすめします。</p>':"")+
      '<div class="rail"><i style="width:'+pct+'%"></i></div>'+
      '<div class="acts"></div>'+
    '</div></article>');
  var acts=el.querySelector(".acts");
  function add(label,cls,fn){ var b=h('<button class="act '+(cls||"")+'">'+label+'</button>'); b.onclick=fn; acts.appendChild(b); }
  if(!it.done){
    if(isCopy){
      // 2回目以降の表示専用コピー：この回の取りやめと、.ics書き出しのみ許可
      var key=toLocalISO(parseItemDate(it));
      add("この回は休み","",function(){
        if(confirm(key+" の回だけ取りやめます。よろしいですか？")) animateCardOut(el, "skipping", "休み", function(){ skipOccurrence(it.id, key); });
      });
      add("カレンダーへ","primary",function(){ downloadICS([it], it.title); });
      var note=h('<div style="font-size:11.5px;color:var(--ink-3);margin-top:6px">完了・編集は「定期予定」タブから行ってください</div>');
      el.querySelector(".body").appendChild(note);
    } else {
      add("完了にする","main",function(){ complete(it, el); });
      if(st==="over" && !isRepeating(it)){
        add("明日に延期","",function(){ animateCardOut(el, "postponing", "延期", function(){ postpone(it); }); });
      }
      if(isRepeating(it)){
        var key0=toLocalISO(parseItemDate(it));
        add("この回は休み","",function(){
          if(confirm(key0+" の回だけ取りやめます。よろしいですか？")) animateCardOut(el, "skipping", "休み", function(){ skipOccurrence(it.id, key0); });
        });
      }
      add("カレンダーへ","primary",function(){ downloadICS([it], it.title); });
      add("編集","",function(){ openDialog(it); });
      add("雛形に保存","",function(){ saveAsTemplate(it); });
    }
  } else {
    add("戻す","",function(){
      // 完了の記録とEXPも取り消す（同じ締切を何度も完了→戻すでEXPが増えないように）
      if(it.doneLog) db.completions=db.completions.filter(function(c){ return c.id!==it.doneLog; });
      it.done=false; delete it.doneAt; delete it.doneLog; save(); render(); scheduleAutoSync();
    });
  }
  add("削除","danger",function(){ if(confirm("「"+it.title+"」を削除します。よろしいですか？")){ animateCardOut(el, "deleting", "", function(){ deleteItem(it); }); } });
  return el;
}

/* 締切を登録・編集したとき、設定が揃っていれば自動で同期する。
   同期先やトークンが未設定なら何もしない（初回利用者の邪魔をしない） */
function autoSyncIfConfigured(){
  clearTimeout(_autoSyncTimer); _autoSyncTimer=null;
  if(!db.settings.autoSync) return;
  getStoredGhConfig().then(function(cfg){ if(cfg) autoSyncWith(cfg); }).catch(function(){});
}
function autoSyncWith(cfg){
  var pushedAt=db.updatedAt; // 送信中に別の編集が入っても、送った時点の値を記録するため捕捉しておく
  var content=utf8ToBase64(JSON.stringify(syncPayload(),null,2));

  function put(sha){
    var body={message:"締切データを自動同期（"+new Date().toLocaleString("ja-JP")+"）",content:content,branch:cfg.branch};
    if(sha) body.sha=sha;
    return fetch(cfg.api,{method:"PUT",
      headers:Object.assign({"Content-Type":"application/json"},cfg.headers),
      body:JSON.stringify(body)});
  }
  // GitHub上に「この端末がまだ取り込んでいない他の端末の更新」があれば、上書きして消さないよう止める
  function checkedPut(){
    return fetchRemoteState(cfg).then(function(r){
      if(remoteHasUnknownChanges(r)){
        if(!_autoSyncBlockedShown){
          _autoSyncBlockedShown=true;
          toast("GitHubに他の端末の更新があるため、自動同期を止めました。設定タブで読み込むか同期するかを選んでください");
        }
        return null;
      }
      return put(r.sha);
    });
  }
  checkedPut()
    .then(function(res){ if(res && res.status===409) return checkedPut(); return res; })
    .then(function(res){
      if(res && res.ok){
        markSynced("自動同期");
        markPulled(); // 送った内容＝この端末の最新状態としてよい
        store.set("gh-known-updatedAt", pushedAt); // GitHubともこの時点で一致した
        _autoSyncBlockedShown=false;
        toast("GitHubに自動同期しました");
      }
    })
    .catch(function(){ /* 自動処理なので失敗しても通知しない */ });
}
/* 完了・削除などの操作は続けて行うことが多いので、少し待ってからまとめて1回だけ自動同期する。
   画面を閉じる(アプリを切り替える)ときは待たずにすぐ送る */
var _autoSyncTimer=null, _autoSyncBlockedShown=false;
function scheduleAutoSync(){
  if(!db.settings.autoSync) return;
  clearTimeout(_autoSyncTimer);
  _autoSyncTimer=setTimeout(autoSyncIfConfigured, 3000);
}
function flushAutoSync(){ if(_autoSyncTimer) autoSyncIfConfigured(); }

/* GitHubへ送る内容。設定(テーマ等)とこの端末専用の隔離データは含めない */
function syncPayload(){
  return {items:db.items, templates:db.templates, trash:db.trash, categories:db.categories, catReminders:db.catReminders, catColors:db.catColors,
          completions:db.completions, expCarry:db.expCarry||0, updatedAt:db.updatedAt};
}
/* GitHub上のdata.jsonの版(sha)と更新時刻を取得する。まだ無ければ sha:null */
function fetchRemoteState(cfg){
  return fetch(cfg.api+"?ref="+encodeURIComponent(cfg.branch)+"&_="+Date.now(),{headers:cfg.headers, cache:"no-store"})
    .then(function(res){
      if(res.status===404) return {sha:null, updatedAt:null};
      if(!res.ok) return res.json().then(function(e){ throw new Error(e.message||("HTTP "+res.status)); });
      return res.json().then(function(j){
        var at=null;
        try{ if(j.content) at=JSON.parse(base64ToUtf8(j.content)).updatedAt||null; }catch(e){}
        return {sha:j.sha, updatedAt:at};
      });
    });
}
/* GitHub上に、この端末が前回の同期・読み込み以降に知らない更新があるか */
function remoteHasUnknownChanges(r){
  if(!r.sha) return false;                      // まだファイルが無い
  var known=store.get("gh-known-updatedAt");
  if(!known) return true;                       // 一度も同期していない端末は、既存の内容を知らない
  return !!(r.updatedAt && r.updatedAt>known);
}

/* Discordの本文上限は2000文字。超える分は切り詰める */
function fitDiscord(text){
  return text.length>1900 ? text.slice(0,1880)+"\n…（件数が多いため省略しました）" : text;
}

/* 締切を登録・編集したとき、設定が揃っていればDiscordへ通知する */
function autoNotifyIfConfigured(){
  if(!db.settings.autoNotify) return;
  secretGet("dc-hook").then(function(hook){
    if(!hook) return;
    return fetch(hook,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:fitDiscord(buildDigestText())})});
  }).catch(function(){});
}

/* 期限切れからの経過日数。滞留（長く放置されている状態）の判定に使う */
function overdueDays(it){
  var due=parseItemDate(it);
  if(due>=new Date()) return -1;
  return daysBetween(due, new Date());
}
function isStale(it){ return overdueDays(it)>=7; }

/* 最後に同期・読み込みした時刻を記録する（設定タブに表示して、
   同期し忘れに気づけるようにするため） */
function markSynced(kind){
  store.set("gh-last-sync", JSON.stringify({at:new Date().toISOString(), kind:kind}));
  flashSynced();
}
/* 同期が終わったことを、ヘッダーに一瞬だけ「✓ 同期済み」と出して知らせる */
function flashSynced(){
  var bar=document.getElementById("lvlBar"); if(!bar) return;
  var old=document.querySelector(".sync-flash"); if(old) old.remove();
  var f=h('<span class="sync-flash" role="status">✓ 同期済み</span>');
  bar.appendChild(f);
  setTimeout(function(){ f.classList.add("out"); setTimeout(function(){ f.remove(); }, 400); }, 1600);
}
/* この端末がGitHub上のデータを最後に取得した時刻。
   「同期する」の前にこれが古いままだと、古い内容で上書きしてしまう危険がある */
function markPulled(){
  store.set("gh-last-pulled", new Date().toISOString());
}
function hoursSincePulled(){
  var raw=store.get("gh-last-pulled");
  if(!raw) return null; // 一度も取得していない（まだ判断材料がない）
  return (Date.now()-new Date(raw).getTime())/3600000;
}
/* 「3時間前」のような相対表記にする。数字より状態が伝わりやすい */
function lastSyncText(){
  var raw=store.get("gh-last-sync");
  if(!raw) return null;
  try{
    var d=JSON.parse(raw);
    var t=new Date(d.at);
    var min=Math.floor((Date.now()-t)/60000);
    var rel;
    if(min<1) rel="たった今";
    else if(min<60) rel=min+"分前";
    else if(min<24*60) rel=Math.floor(min/60)+"時間前";
    else rel=Math.floor(min/1440)+"日前";
    return {
      text:t.getFullYear()+"/"+(t.getMonth()+1)+"/"+t.getDate()+" "+pad(t.getHours())+":"+pad(t.getMinutes()),
      rel:rel, kind:d.kind||"同期", stale:(min>=24*60)
    };
  }catch(e){ return null; }
}

/* テンプレートの内容をフォームに反映する。
   日付は毎回違うため入れない（意図しない日付のまま保存されるのを防ぐ） */
function applyTemplate(id){
  if(!id) return;
  var t=db.templates.filter(function(x){ return x.id===id; })[0];
  if(!t) return;
  document.getElementById("fTitle").value=t.title||"";
  document.getElementById("fMemo").value=t.memo||"";
  document.getElementById("fCat").value=(db.categories.indexOf(t.cat)>=0)?t.cat:db.categories[0];
  refreshDlgColor(t.color||null);
  document.getElementById("fRep").value=t.rep||"none";
  setRepCountValue(t.repCount==null?15:t.repCount);
  document.getElementById("fAllDay").checked=!!t.allDay;
  document.getElementById("fAutoComplete").checked=!!t.autoComplete;
  document.getElementById("fCalShow").checked=!t.calHide;
  document.getElementById("fTime").value=t.timeOfDay||"09:00";
  document.getElementById("fSpan").checked=false;
  syncDialogRows();
  // 日付はテンプレートに含めない。ただし、カレンダーから開いたなど
  // すでに日付が入っている場合はその選択を尊重する
  var dateEl=document.getElementById("fDate");
  if(dateEl.value){
    toast("「"+t.name+"」を読み込みました");
  } else {
    dateEl.focus();
    toast("「"+t.name+"」を読み込みました。日付を入力してください");
  }
}

/* いまある締切をテンプレートとして保存する */
function saveAsTemplate(it){
  var name=prompt("テンプレート名を入力してください", it.title);
  if(name===null) return;
  name=name.trim();
  if(!name){ toast("名前が空です"); return; }
  var d=parseItemDate(it);
  db.templates.push({
    id:"t"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    name:name, title:it.title, cat:it.cat, memo:it.memo||"",
    allDay:!!it.allDay, rep:it.rep||"none", repCount:it.repCount||0,
    autoComplete:!!it.autoComplete, calHide:!!it.calHide, color:normHex(it.color)||undefined,
    timeOfDay:it.allDay?"09:00":(pad(d.getHours())+":"+pad(d.getMinutes()))
  });
  save(); render();
  toast("テンプレート「"+name+"」を保存しました");
}

/* 削除は完全に消さずゴミ箱へ移す。トーストの「元に戻す」は直前の1件だけの最速手段、
   ゴミ箱は30日以内ならいつでも設定タブから戻せる */
var lastDeleted=null;
function deleteItem(it){
  var idx=db.items.findIndex(function(x){ return x.id===it.id; });
  if(idx<0) return;
  lastDeleted={item:db.items[idx], index:idx};
  db.items.splice(idx,1);
  var trashId="tr"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  db.trash.push({trashId:trashId, item:lastDeleted.item, deletedAt:new Date().toISOString()});
  if(db.trash.length>30) db.trash.shift(); // 上限を超えたら最も古いものから消える
  save(); render();
  playSfx("remove");
  toast("「"+it.title+"」を削除しました", "元に戻す", undoDelete);
  scheduleAutoSync();
}
function undoDelete(){
  if(!lastDeleted) return;
  var pos=Math.min(lastDeleted.index, db.items.length);
  db.items.splice(pos,0,lastDeleted.item);
  // ゴミ箱に入れた直後の同一項目も取り除く(id一致・末尾付近を優先して探す)
  for(var i=db.trash.length-1;i>=0;i--){
    if(db.trash[i].item.id===lastDeleted.item.id){ db.trash.splice(i,1); break; }
  }
  var restored=lastDeleted.item.title;
  lastDeleted=null;
  save(); render();
  toast("「"+restored+"」を元に戻しました");
  scheduleAutoSync();
}
/* 期限を過ぎた締切を「明日の同じ時刻」へ延ばす。期間つきは開始日も同じだけずらす */
function postpone(it){
  var due=parseItemDate(it), t=new Date();
  var nd=new Date(t.getFullYear(),t.getMonth(),t.getDate()+1,due.getHours(),due.getMinutes());
  var before={due:it.due, start:it.start};
  var shift=nd-due;
  it.due=nd.toISOString();
  if(it.start) it.start=new Date(new Date(it.start).getTime()+shift).toISOString();
  it.seq=(it.seq||0)+1;
  save(); render();
  toast("締切を "+fmtDue(nd,it.allDay)+" に延期しました", "元に戻す", function(){
    it.due=before.due;
    if(before.start) it.start=before.start; else delete it.start;
    it.seq=(it.seq||0)+1;
    save(); render(); scheduleAutoSync();
  });
  scheduleAutoSync();
}
/* ゴミ箱から個別に復元する。同じidが既に一覧にある場合(自動pull等で復活済み)は
   上書きせず、その旨を知らせるだけにする */
function restoreFromTrash(trashId){
  var idx=db.trash.findIndex(function(t){ return t.trashId===trashId; });
  if(idx<0) return;
  var entry=db.trash[idx];
  if(db.items.some(function(x){ return x.id===entry.item.id; })){
    toast("同じ締切が既に一覧にあるため、復元しませんでした");
    db.trash.splice(idx,1); save(); render();
    return;
  }
  db.items.push(entry.item);
  db.trash.splice(idx,1);
  save(); render();
  toast("「"+entry.item.title+"」を元に戻しました");
  scheduleAutoSync();
}
function purgeTrashItem(trashId){
  db.trash=db.trash.filter(function(t){ return t.trashId!==trashId; });
  save(); render();
}
/* 隔離した項目を、登録ダイアログを使って修復する。
   壊れたidをそのまま使うと既存の編集ロジックと整合しないため、
   「新規登録」として開き、保存できたら隔離から取り除く方式にする */
var fixingQuarantineId=null;
function openQuarantineFixDialog(qid){
  var q=db.quarantine.filter(function(x){ return x.qid===qid; })[0];
  if(!q) return;
  var raw=q.raw||{};
  // dueが不正な場合はダイアログを開ける形にするため、仮に今日を入れておく（保存時に必ず選び直させる）
  var seed={
    title:(typeof raw.title==="string")?raw.title:"",
    due:(function(){ var d=new Date(raw.due); return isNaN(d.getTime())?new Date().toISOString():raw.due; })(),
    cat:(typeof raw.cat==="string"&&db.categories.indexOf(raw.cat)>=0)?raw.cat:db.categories[0],
    memo:(typeof raw.memo==="string")?raw.memo:""
  };
  openDialog(null); // 新規登録として開く
  fixingQuarantineId=qid; // openDialogの後に設定する（開く処理でリセットされないように）
  document.getElementById("fTitle").value=seed.title;
  document.getElementById("fMemo").value=seed.memo;
  document.getElementById("fCat").value=seed.cat;
  refreshDlgColor();
  var d=new Date(seed.due);
  document.getElementById("fDate").value=toLocalISO(d);
  syncDialogRows();
  toast("内容を修正してから保存してください");
}

function purgeAllTrash(){
  if(!db.trash.length){ toast("ゴミ箱は空です"); return; }
  if(!confirm("ゴミ箱の"+db.trash.length+"件をすべて完全に削除します。元に戻せません。よろしいですか？")) return;
  db.trash=[];
  save(); render();
  toast("ゴミ箱を空にしました");
}

function purgeQuarantineItem(qid){
  db.quarantine=db.quarantine.filter(function(q){ return q.qid!==qid; });
  save(); render();
}

function isRepeating(it){ return !!(it.rep&&it.rep!=="none"); }

/* タイトル・メモの部分一致で絞り込む検索欄 */
function searchBar(){
  var bar=h('<div style="margin:12px 0 -2px"><input type="text" id="searchBox" placeholder="タイトルで検索"></div>');
  var input=bar.querySelector("input");
  input.value=searchKw;
  input.oninput=function(){
    searchKw=input.value;
    renderListBody(); // 欄自体は再描画せず、結果だけ差し替えてIME入力中の欠落を防ぐ
  };
  return bar;
}
function matchesSearch(it){
  if(!searchKw.trim()) return true;
  var kw=searchKw.trim().toLowerCase();
  return (it.title||"").toLowerCase().indexOf(kw)>=0 || (it.memo||"").toLowerCase().indexOf(kw)>=0;
}

function renderList(){
  main.appendChild(quickBar());
  main.appendChild(todaySummary());
  main.appendChild(filterBar());
  main.appendChild(searchBar());
  var body=h('<div id="listBody"></div>');
  main.appendChild(body);
  renderListBody();
}

/* ========== 自然文クイック入力（案C） ==========
   「明日 17時 レポート提出」のような1行から日時・繰り返し・カテゴリ・テンプレートを読み取り、
   登録ダイアログに下書きとして入れて開く。読み取れなかった部分はダイアログで直してもらう */
var quickText="", quickHelpOpen=false, fromQuick=false;
var QUICK_DOW={"日":0,"月":1,"火":2,"水":3,"木":4,"金":5,"土":6};
function toHalfWidth(s){
  return s.replace(/[０-９Ａ-Ｚａ-ｚ：／＃]/g,function(c){ return String.fromCharCode(c.charCodeAt(0)-0xFEE0); }).replace(/\u3000/g," ");
}
function parseQuick(text, now){
  now=now||new Date();
  var t=" "+toHalfWidth(text)+" ";
  var today=startOfDay(now);
  var r={title:"", date:null, time:null, allDay:false, rep:"none", cat:null, tpl:null};
  function take(re, fn){
    var m=t.match(re);
    if(!m) return false;
    if(fn(m)===false) return false;
    t=t.slice(0,m.index)+" "+t.slice(m.index+m[0].length);
    return true;
  }
  function addDays(n){ return new Date(today.getFullYear(),today.getMonth(),today.getDate()+n); }

  take(/(毎週|隔週|毎月|毎年)/, function(m){ r.rep={"毎週":"weekly","隔週":"biweekly","毎月":"monthly","毎年":"yearly"}[m[1]]; });
  take(/終日/, function(){ r.allDay=true; });
  take(/#(\S+)/, function(m){ if(db.categories.indexOf(m[1])<0) return false; r.cat=m[1]; });

  // 日付（先に年つき→月日→相対表現→曜日の順で試す）
  take(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?/, function(m){
    var d=new Date(+m[1],+m[2]-1,+m[3]); if(d.getMonth()!==+m[2]-1) return false; r.date=d; })
  || take(/(\d{1,2})月(\d{1,2})日|(\d{1,2})\/(\d{1,2})(?![\d:])/, function(m){
    var mo=+(m[1]||m[3]), da=+(m[2]||m[4]);
    var d=new Date(today.getFullYear(),mo-1,da);
    if(d.getMonth()!==mo-1) return false;
    if(d<today) d=new Date(today.getFullYear()+1,mo-1,da); // 過ぎた日付は来年とみなす（12月に「1/5」など）
    r.date=d; })
  || take(/(明後日|あさって)/, function(){ r.date=addDays(2); })
  || take(/(明日|あした|あす)/, function(){ r.date=addDays(1); })
  || take(/(今日|きょう)/, function(){ r.date=addDays(0); })
  || take(/(\d{1,3})日後/, function(m){ r.date=addDays(+m[1]); })
  || take(/(再来週|来週|今週)?の?([日月火水木金土])曜日?/, function(m){
    var wd=QUICK_DOW[m[2]], dow=today.getDay();
    if(m[1]){
      // 週は月曜はじまり。「来週水曜」＝次の週の水曜
      var monday=addDays(-((dow+6)%7));
      var weeks={"今週":0,"来週":1,"再来週":2}[m[1]];
      r.date=new Date(monday.getFullYear(),monday.getMonth(),monday.getDate()+weeks*7+(wd+6)%7);
    } else {
      r.date=addDays((wd-dow+7)%7); // 曜日だけなら今日を含めて次に来るその曜日
    }
  });

  // 時刻
  take(/正午/, function(){ r.time="12:00"; })
  || take(/(午前|午後)?\s*(\d{1,2})\s*:\s*(\d{2})/, function(m){ return setTime(m[1],+m[2],+m[3]); })
  || take(/(午前|午後)?\s*(\d{1,2})時(?:(半)|(\d{1,2})分)?/, function(m){ return setTime(m[1],+m[2],m[3]?30:(m[4]?+m[4]:0)); });
  function setTime(ampm,hh,mm){
    if(ampm==="午後"&&hh<12) hh+=12;
    if(ampm==="午前"&&hh===12) hh=0;
    if(hh===24&&mm===0){ hh=23; mm=59; }
    if(hh>23||mm>59) return false;
    r.time=pad(hh)+":"+pad(mm);
  }

  // 残りをタイトルにする。前後の助詞や区切りは落とす
  var title=t.replace(/\s+/g," ").trim()
    .replace(/^(までに|まで|から|に|の|は|で|、|,)+\s*/,"").replace(/\s*(までに|まで|に|の|、|,)+$/,"").trim();
  r.title=title;
  // タイトルがテンプレート名と一致すれば、そのテンプレートを使う
  r.tpl=db.templates.filter(function(x){ return x.name===title; })[0]||null;

  // 時刻だけなら、まだ来ていなければ今日・過ぎていれば明日とみなす
  if(r.time && !r.date){
    var p=r.time.split(":"), cand=new Date(today.getFullYear(),today.getMonth(),today.getDate(),+p[0],+p[1]);
    r.date=(cand>now)?today:addDays(1);
  }
  if(r.time) r.allDay=false;
  // 日付だけで時刻が無ければ終日の締切として扱う（テンプレートを使う場合はテンプレートの設定を優先）
  else if(r.date && !r.tpl) r.allDay=true;
  return r;
}
function describeQuick(r){
  var parts=[];
  if(r.date) parts.push("<b>"+escHtml(fmtDue(r.date,true))+(r.time?" "+escHtml(r.time):(r.allDay?" 終日":""))+"</b>");
  else if(r.time) parts.push("<b>"+escHtml(r.time)+"</b>");
  if(r.rep!=="none") parts.push({weekly:"毎週",biweekly:"隔週",monthly:"毎月",yearly:"毎年"}[r.rep]);
  if(r.cat) parts.push("#"+escHtml(r.cat));
  if(r.tpl) parts.push("テンプレート「"+escHtml(r.tpl.name)+"」");
  parts.push(r.title?"「"+escHtml(r.title)+"」":'<span style="color:var(--amber)">タイトル未入力</span>');
  if(!r.date) parts.push('<span style="color:var(--ink-3)">日付は読み取れませんでした（今日で開きます）</span>');
  return "→ "+parts.join("　");
}
function quickBar(){
  var wrap=h('<div><div class="quick"><input type="text" id="quickIn" enterkeyhint="go" autocomplete="off" list="quickTpl" '+
    'placeholder="例：明日 17時 レポート提出"><button>登録へ</button></div>'+
    '<div class="quick-prev" id="quickPrev"></div><datalist id="quickTpl"></datalist></div>');
  var input=wrap.querySelector("input"), prev=wrap.querySelector("#quickPrev"), dl=wrap.querySelector("datalist");
  db.templates.forEach(function(t){ var o=document.createElement("option"); o.value=t.name; dl.appendChild(o); });
  input.value=quickText;
  function update(){
    quickText=input.value;
    if(!quickText.trim()){
      prev.innerHTML='<a href="#" style="color:var(--ink-3)">'+(quickHelpOpen?"書き方を閉じる":"書き方の例")+'</a>';
      prev.querySelector("a").onclick=function(e){ e.preventDefault(); quickHelpOpen=!quickHelpOpen; render(); };
      return;
    }
    prev.innerHTML=describeQuick(parseQuick(quickText));
  }
  input.oninput=update;
  function go(){ if(!input.value.trim()){ input.focus(); return; } openQuickDialog(parseQuick(input.value)); }
  input.onkeydown=function(e){ if(e.key==="Enter" && !e.isComposing){ e.preventDefault(); go(); } };
  wrap.querySelector("button").onclick=go;
  update();
  if(quickHelpOpen && !quickText.trim()){
    wrap.appendChild(h('<div class="quick-help">'+
      '日付：<code>今日</code> <code>明日</code> <code>明後日</code> <code>3日後</code> <code>金曜</code> <code>来週水曜</code> <code>10/15</code> <code>10月15日</code> <code>2027/1/5</code><br>'+
      '時刻：<code>17時</code> <code>17時半</code> <code>17:30</code> <code>午後5時</code> <code>正午</code>（時刻が無ければ終日）<br>'+
      'その他：<code>毎週</code> <code>隔週</code> <code>毎月</code> <code>毎年</code> <code>終日</code> <code>#カテゴリ名</code>、テンプレート名だけを打つとテンプレートを使います<br>'+
      '例：<code>毎週水曜 17:00 バイト #バイト</code>　<code>10/20 レポート提出</code></div>'));
  }
  return wrap;
}
function openQuickDialog(r){
  openDialog(null);
  fromQuick=true;
  if(r.tpl) applyTemplate(r.tpl.id);
  else if(r.title) document.getElementById("fTitle").value=r.title;
  if(r.date){
    document.getElementById("fDate").value=toLocalISO(r.date);
    document.getElementById("fStart").value=toLocalISO(r.date);
  }
  if(r.time) document.getElementById("fTime").value=r.time;
  if(r.time || r.allDay || !r.tpl) document.getElementById("fAllDay").checked=r.allDay;
  if(r.rep!=="none") document.getElementById("fRep").value=r.rep;
  if(r.cat){ document.getElementById("fCat").value=r.cat; refreshDlgColor(); }
  syncDialogRows();
  if(!document.getElementById("fTitle").value) document.getElementById("fTitle").focus();
}

/* 一覧の最上部に出す「今日のサマリー」。開いた瞬間に今日やることだけが分かるようにする。
   折りたたみ状態は端末ごとに覚える（同期はしない） */
function todayItems(){
  var now=new Date(), today=startOfDay(now), end=new Date(today.getFullYear(),today.getMonth(),today.getDate(),23,59,59);
  var key=toLocalISO(now);
  var act=activeItems();
  var due=act.filter(function(i){ return !isRepeating(i) && toLocalISO(parseItemDate(i))===key; });
  var routines=[];
  act.filter(isRepeating).forEach(function(i){ routines=routines.concat(expandOccurrences(i, today, end)); });
  var starts=act.filter(function(i){ return i.start && !isRepeating(i) && toLocalISO(new Date(i.start))===key && toLocalISO(parseItemDate(i))!==key; });
  // 滞留は超過タブと同じ数え方（完了し忘れた定期予定も含む）
  var stale=act.filter(function(i){ return isStale(i); });
  return {due:due.sort(sortByDue), routines:routines.sort(sortByDue), starts:starts.sort(sortByDue), stale:stale};
}
function todaySummary(){
  var t=todayItems();
  var collapsed=store.get("ui-summary-collapsed")==="1";
  var total=t.due.length+t.routines.length+t.starts.length;
  var el=h('<section class="sum"><button class="sum-head" aria-expanded="'+(!collapsed)+'"><b>今日のサマリー</b>'+
    '<span>'+(collapsed?(total?"今日 "+total+" 件"+(t.stale.length?"・滞留 "+t.stale.length+" 件":"")+"　▾":"今日の予定なし　▾"):"▴")+'</span></button></section>');
  el.querySelector(".sum-head").onclick=function(){ store.set("ui-summary-collapsed", collapsed?"0":"1"); render(); };
  if(collapsed) return el;
  var body=h('<div class="sum-body"></div>');
  function cell(n,label,cls,fn){
    var c=h('<button class="sum-cell '+(n&&cls?cls:"")+'"><span class="num" data-to="'+n+'">'+n+'</span><small>'+label+'</small></button>');
    c.onclick=fn; body.appendChild(c);
  }
  var goWeek=function(){ view="week"; window.scrollTo(0,0); render(); };
  cell(t.due.length,"今日が締切","hot",goWeek);
  cell(t.routines.length,"今日の定期予定","rt",goWeek);
  cell(t.starts.length,"今日から開始","",goWeek);
  cell(t.stale.length,"7日以上の滞留","hot",function(){ view="over"; window.scrollTo(0,0); render(); });
  var lines=t.due.concat(t.routines,t.starts).slice(0,5);
  if(lines.length){
    var ul=h('<ul class="sum-list"></ul>');
    lines.forEach(function(i){
      var d=parseItemDate(i);
      var when=t.starts.indexOf(i)>=0?"開始":(i.allDay?"終日":fmtTime(d));
      ul.appendChild(h('<li>'+(isRepeating(i)?"🔁 ":"・")+'<span class="num">'+escHtml(when)+'</span>　'+escHtml(i.title)+'</li>'));
    });
    var more=total-lines.length;
    if(more>0) ul.appendChild(h('<li style="color:var(--ink-3)">ほか '+more+' 件</li>'));
    body.appendChild(ul);
  }
  el.appendChild(body);
  return el;
}

function renderListBody(){
  var body=document.getElementById("listBody");
  if(!body) return;
  body.innerHTML="";
  // 定期予定は次の回だけを並べる（この端末だけの設定で隠せる）
  var showRoutine=store.get("list-show-routine")!=="0";
  var rtToggle=h('<label class="cal-opt list-opt"><input type="checkbox"'+(showRoutine?" checked":"")+'>定期予定も表示</label>');
  rtToggle.querySelector("input").onchange=function(){ store.set("list-show-routine", this.checked?"1":"0"); renderListBody(); };
  body.appendChild(rtToggle);
  var list=activeItems().filter(function(i){ return (filter==="ALL"||i.cat===filter)&&(showRoutine||!isRepeating(i))&&matchesSearch(i); }).sort(sortByDue);
  if(!list.length){
    var msg=searchKw.trim()
      ? '<div class="empty" style="margin-top:18px"><b>見つかりませんでした</b>「'+escHtml(searchKw)+'」に一致する締切はありません。</div>'
      : '<div class="empty" style="margin-top:18px"><b>登録された締切はありません</b>下のボタンから最初の締切を登録してください。</div>';
    body.appendChild(h(msg));
    return;
  }
  var now=new Date();
  // グループ分けもカードの残り日数と同じ基準（期間つきは開始日）で判定する
  var groups=[
    ["期限切れ", function(i){ return parseItemDate(i)<now; }],
    ["今日", function(i){ return daysBetween(now,refDate(i))===0; }],
    ["明日", function(i){ return daysBetween(now,refDate(i))===1; }],
    ["今週（7日以内）", function(i){ var n=daysBetween(now,refDate(i)); return n>1&&n<=7; }],
    ["これから", function(i){ return daysBetween(now,refDate(i))>7; }]
  ];
  var used={};
  groups.forEach(function(g){
    var arr=list.filter(function(i){ return !used[i.id]&&g[1](i); });
    arr.forEach(function(i){ used[i.id]=1; });
    if(!arr.length) return;
    // 期限切れの中では、長く放置されているものを先頭に出す
    if(g[0]==="期限切れ"){
      arr.sort(function(a,b){ return overdueDays(b)-overdueDays(a); });
      var stale=arr.filter(isStale).length;
      body.appendChild(h('<div class="group-label">'+g[0]+(stale?'（うち '+stale+' 件が7日以上）':'')+'</div>'));
    } else {
      body.appendChild(h('<div class="group-label">'+g[0]+'</div>'));
    }
    arr.forEach(function(i){ body.appendChild(cardOf(i)); });
  });
  var all=h('<div style="margin:20px 0 0"><button class="act primary" style="padding:8px 14px">表示中の締切をまとめてカレンダーへ書き出す</button></div>');
  all.querySelector("button").onclick=function(){ downloadICS(list,"deadlines"); };
  body.appendChild(all);
}

/* 期限を過ぎたものだけを集める。経過が長いものほど上に出す */
function renderOverdue(){
  main.appendChild(filterBar());
  // 完了にし忘れた定期予定の回もここに出す（完了にすると次回へ進む）
  var list=activeItems()
    .filter(function(i){ return (filter==="ALL"||i.cat===filter)&&parseItemDate(i)<new Date(); })
    .sort(function(a,b){ return overdueDays(b)-overdueDays(a); });

  if(!list.length){
    main.appendChild(h('<div class="empty" style="margin-top:18px"><b>超過しているものはありません</b>すべて期限内です。</div>'));
    return;
  }
  var stale=list.filter(isStale).length;
  main.appendChild(h('<div class="notice" style="margin-top:14px">'+
    '合計 '+list.length+' 件が期限を過ぎています'+(stale?'（うち '+stale+' 件は7日以上）':'')+'。'+
    '対応済みのものは完了か削除にしておくと、毎朝の連絡が見やすくなります。</div>'));

  var groups=[
    ["7日以上 放置", function(i){ return overdueDays(i)>=7; }],
    ["3〜6日 経過",  function(i){ var n=overdueDays(i); return n>=3&&n<7; }],
    ["2日以内",      function(i){ return overdueDays(i)<3; }]
  ];
  var used={};
  groups.forEach(function(g){
    var arr=list.filter(function(i){ return !used[i.id]&&g[1](i); });
    arr.forEach(function(i){ used[i.id]=1; });
    if(!arr.length) return;
    main.appendChild(h('<div class="group-label">'+g[0]+'（'+arr.length+'件）</div>'));
    arr.forEach(function(i){ main.appendChild(cardOf(i)); });
  });

  // まとめて片付けるための導線
  var bulk=h('<div style="margin:20px 0 0"><button class="act danger" style="padding:8px 14px">7日以上のものをまとめて完了にする</button></div>');
  bulk.querySelector("button").onclick=function(){
    var target=list.filter(isStale);
    if(!target.length){ toast("7日以上のものはありません"); return; }
    if(!confirm(target.length+"件をまとめて完了にします。よろしいですか？")) return;
    // 定期予定は done にすると次回以降も消えるため、通常の完了処理(次回へ進める)を通す
    target.forEach(function(i){ applyCompletion(i, "bulk"); });
    save(); render(); toast(target.length+"件を完了にしました");
    scheduleAutoSync();
  };
  main.appendChild(bulk);
}

/* 今日から7日分を縦に並べる。予定のない日も行として出す（空白に意味がある） */
function renderWeek(){
  main.appendChild(filterBar());
  var today=startOfDay(new Date());
  var last=new Date(today.getFullYear(),today.getMonth(),today.getDate()+6,23,59,59);

  // 繰り返しは表示範囲ぶんだけ展開する（カレンダーと同じ処理を流用）
  var items=[];
  db.items.filter(function(i){ return (filter==="ALL"||i.cat===filter)&&!i.done; })
    .forEach(function(i){ items=items.concat(expandOccurrences(i, today, last)); });

  var wrap=h('<div class="week"></div>');
  var total=0;
  for(var k=0;k<7;k++){
    var d=new Date(today.getFullYear(),today.getMonth(),today.getDate()+k);
    var key=toLocalISO(d);
    // その日が締切の予定と、期間の途中にある予定を集める
    var hit=items.filter(function(i){
      var dueKey=toLocalISO(parseItemDate(i));
      if(dueKey===key) return true;
      if(!i.start) return false;
      return key>=toLocalISO(new Date(i.start)) && key<dueKey;
    }).sort(sortByDue);
    total+=hit.length;

    var hol=holidayName(key);
    var dowCls=(d.getDay()===0||hol?" sun":d.getDay()===6?" sat":"");
    var label=(k===0?"今日":k===1?"明日":"");
    var row=h('<div class="wday'+(k===0?" is-today":"")+'">'+
      '<div class="wday-head tap'+dowCls+'" title="この日を時間軸で見る"><span class="num">'+(d.getMonth()+1)+'/'+d.getDate()+'</span>'+
      '<span class="wdow">（'+DOW[d.getDay()]+'）</span><span class="wgo">›</span>'+
      (label?'<span class="wtag">'+label+'</span>':'')+
      (hol?'<span class="wdow" style="width:100%">'+escHtml(hol)+'</span>':'')+'</div>'+
      '<div class="wday-body"></div></div>');
    row.querySelector(".wday-head").onclick=(function(key){ return function(){ openDayView(key); }; })(key);
    var body=row.querySelector(".wday-body");
    if(!hit.length){
      body.appendChild(h('<div class="wnone">予定なし</div>'));
    } else {
      hit.forEach(function(i){
        var isDue=(toLocalISO(parseItemDate(i))===key);
        var mark=isRepeating(i)?"🔁":(isDue?"・":"↳");
        var when=i.allDay?"終日":(isDue?fmtTime(parseItemDate(i)):"期間中");
        var item=h('<div class="witem'+(isRepeating(i)?" routine":"")+'">'+
          '<span class="wmark">'+mark+'</span>'+
          swatch(itemColor(i))+'<span class="wtitle">'+escHtml(i.title)+'</span>'+
          '<span class="wcat">'+escHtml(i.cat||"")+'</span>'+
          '<span class="wtime num">'+escHtml(when)+'</span></div>');
        item.onclick=(function(key){ return function(){ view="cal"; selDay=key; calRef=new Date(key+"T00:00:00"); render(); }; })(key);
        body.appendChild(item);
      });
    }
    wrap.appendChild(row);
  }
  main.appendChild(wrap);
  if(!total) main.appendChild(h('<div class="empty" style="margin-top:14px">この7日間に予定はありません。</div>'));
  main.appendChild(h('<p style="font-size:11.5px;color:var(--ink-3);margin:10px 0 0">日付をタップすると、その日を時間軸で表示します。</p>'));
}
function fmtTime(d){ return pad(d.getHours())+":"+pad(d.getMinutes()); }

/* 予定が占める時間帯。.ics の書き出しと同じ定義にそろえる：
   期間つきは開始〜締切、それ以外は「締切の30分前〜締切」。
   終日と、日をまたぐ期間つき予定は時間帯を持たないものとして null を返す */
var EVENT_MINUTES=30;
function timeRangeOf(it){
  if(it.allDay) return null;
  var end=parseItemDate(it);
  if(it.start){
    var st=new Date(it.start);
    if(toLocalISO(st)!==toLocalISO(end)) return null; // 数日にまたがる期間は対象外
    return {start:st, end:end};
  }
  return {start:new Date(end.getTime()-EVENT_MINUTES*60000), end:end};
}
function rangesOverlap(a,b){ return a.start<b.end && b.start<a.end; }

/* 指定日の予定（繰り返しはその日の回だけ展開する）。完了済みは除く */
function itemsOnDay(key, opt){
  opt=opt||{};
  var d0=new Date(key+"T00:00:00"), d1=new Date(key+"T23:59:59");
  var out=[];
  db.items.forEach(function(i){
    if(i.done || (opt.excludeId && i.id===opt.excludeId)) return;
    if(opt.cat && opt.cat!=="ALL" && i.cat!==opt.cat) return;
    // 期間つきは開始日から締切日までどこかにかかっていれば拾う
    var from=i.start?new Date(d0.getTime()-(parseItemDate(i)-new Date(i.start))):d0;
    expandOccurrences(i, from, new Date(d1.getTime()+(i.start?(parseItemDate(i)-new Date(i.start)):0))).forEach(function(c){
      var dueKey=toLocalISO(parseItemDate(c));
      if(dueKey===key || (c.start && key>=toLocalISO(new Date(c.start)) && key<dueKey)) out.push(c);
    });
  });
  return out;
}

/* 登録・編集中の予定と時間帯が重なる、同じ日の予定を探す（案B） */
function findOverlaps(range, key, excludeId){
  return itemsOnDay(key,{excludeId:excludeId}).filter(function(i){
    var r=timeRangeOf(i);
    return r && rangesOverlap(range, r);
  }).sort(sortByDue);
}

/* 日表示（タイムライン）。今週タブの日付やカレンダーの選択日から開く（案A） */
var dayKey=null;
function openDayView(key){ dayKey=key; view="day"; window.scrollTo(0,0); render(); }
function renderDay(){
  var key=dayKey||toLocalISO(new Date());
  var d=new Date(key+"T00:00:00");
  var hol=holidayName(key);
  var head=h('<div class="dv-head"><h2><span class="num">'+(d.getMonth()+1)+'/'+d.getDate()+'</span>（'+DOW[d.getDay()]+'）'+
    (hol?' <span style="font-size:12px;color:var(--red)">'+escHtml(hol)+'</span>':'')+'</h2><div class="row"></div></div>');
  function shift(n){ var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()+n); openDayView(toLocalISO(x)); }
  var prev=h('<button class="nav" title="前の日">‹</button>'), next=h('<button class="nav" title="次の日">›</button>');
  var back=h('<button class="nav" style="width:auto;padding:0 10px;font-size:12px">今週へ</button>');
  prev.onclick=function(){ shift(-1); }; next.onclick=function(){ shift(1); };
  back.onclick=function(){ view="week"; render(); };
  head.querySelector(".row").append(prev,back,next);
  main.appendChild(filterBar());
  main.appendChild(head);

  var all=itemsOnDay(key,{cat:filter});
  var timed=[], bands=[];
  all.forEach(function(i){ (timeRangeOf(i)?timed:bands).push(i); });

  // 時間軸に乗らないもの（終日・数日にまたがる期間）は上部に帯で出す
  if(bands.length){
    var box=h('<div class="dv-allday"></div>');
    bands.sort(sortByDue).forEach(function(i){
      var due=parseItemDate(i), isDue=toLocalISO(due)===key;
      var note=i.start&&!isDue?("〜"+fmtDue(due,i.allDay)):(i.allDay?"終日":"");
      var b=h('<div class="dv-band'+(isRepeating(i)?" routine":"")+'">'+(isRepeating(i)?"🔁 ":"")+escHtml(i.title)+'<small>'+escHtml(note)+'</small></div>');
      b.onclick=function(){ openFromDayView(i); };
      box.appendChild(b);
    });
    main.appendChild(box);
  }

  var scroll=h('<div class="dv-scroll"></div>'), grid=h('<div class="dv-grid"></div>');
  for(var hr=0;hr<24;hr++) grid.appendChild(h('<div class="dv-hour" style="top:calc('+hr+' * var(--hh))">'+hr+':00</div>'));

  // 重なる予定は横に並べる。重なりの塊ごとに列を割り当てる
  var evs=timed.map(function(i){ var r=timeRangeOf(i); return {it:i, s:r.start, e:r.end}; })
    .sort(function(a,b){ return a.s-b.s || b.e-a.e; });
  var cluster=[], clusterEnd=null;
  function flush(){
    var cols=[];
    cluster.forEach(function(ev){
      var c=0; while(cols[c] && cols[c]>ev.s) c++;
      cols[c]=ev.e; ev.col=c;
    });
    cluster.forEach(function(ev){ ev.ncol=cols.length; });
    cluster=[]; clusterEnd=null;
  }
  evs.forEach(function(ev){
    if(clusterEnd && ev.s>=clusterEnd) flush();
    cluster.push(ev);
    clusterEnd=(!clusterEnd||ev.e>clusterEnd)?ev.e:clusterEnd;
  });
  flush();
  var hh=44;
  evs.forEach(function(ev){
    var top=(ev.s.getHours()*60+ev.s.getMinutes())/60*hh;
    var mins=Math.max(20,(ev.e-ev.s)/60000);
    var i=ev.it, cls=isRepeating(i)?"routine":statusOf(i);
    var byCat=calColorMode()==="cat";
    var el=h('<div class="dv-ev '+cls+(byCat?" bycat":"")+'" style="top:'+top+'px;height:'+(mins/60*hh-2)+'px;'+(byCat?'--cc:'+itemColor(i)+';':'')+
      'left:calc('+(ev.col*100/ev.ncol)+'% + 2px);width:calc('+(100/ev.ncol)+'% - 4px)">'+
      '<b>'+(isRepeating(i)?"🔁 ":"")+escHtml(i.title)+'</b><span class="num">'+
      (i.start?fmtTime(ev.s)+"–":"")+fmtTime(ev.e)+(i.start?"":" 締切")+'</span></div>');
    el.onclick=function(){ openFromDayView(i); };
    grid.appendChild(el);
  });
  var isToday=(key===toLocalISO(new Date()));
  if(isToday){
    var n=new Date();
    grid.appendChild(h('<div class="dv-now" style="top:'+((n.getHours()*60+n.getMinutes())/60*hh)+'px"></div>'));
  }
  scroll.appendChild(grid);
  main.appendChild(scroll);
  if(!all.length) main.appendChild(h('<div class="empty" style="margin-top:12px">この日の予定はありません。</div>'));
  // 今日なら今の時刻の少し前、それ以外は最初の予定か8時あたりから見せる
  var firstH=isToday?Math.max(0,new Date().getHours()-1):(evs.length?Math.max(0,evs[0].s.getHours()-1):8);
  setTimeout(function(){ scroll.scrollTop=firstH*hh; },0);
}
/* 日表示から予定を開く。繰り返しの回は表示用の複製なので、定期予定タブへ移る */
function openFromDayView(i){
  if(isRepeating(i)){ view="rep"; window.scrollTo(0,0); render(); toast("定期予定は「定期予定」タブから編集・完了できます"); return; }
  var orig=db.items.filter(function(x){ return x.id===i.id; })[0];
  if(orig) openDialog(orig);
}

function renderRepeat(){
  main.appendChild(filterBar());
  var list=activeItems().filter(function(i){ return (filter==="ALL"||i.cat===filter)&&isRepeating(i); }).sort(sortByDue);
  if(!list.length){
    main.appendChild(h('<div class="empty" style="margin-top:18px"><b>定期予定はありません</b>締切を登録するとき「繰り返し」を選ぶと、ここにまとまります。</div>'));
    return;
  }
  var labels={weekly:"毎週",biweekly:"隔週",monthly:"毎月",yearly:"毎年"};
  ["weekly","biweekly","monthly","yearly"].forEach(function(rep){
    var arr=list.filter(function(i){ return i.rep===rep; });
    if(!arr.length) return;
    main.appendChild(h('<div class="group-label">'+labels[rep]+'</div>'));
    arr.forEach(function(i){
      main.appendChild(cardOf(i));
      // 取りやめた回があれば一覧を出し、戻せるようにする
      if(i.skip&&i.skip.length){
        var box=h('<div class="skipbox">'+
          '<div style="font-size:11.5px;color:var(--ink-3);letter-spacing:.1em;margin-bottom:6px">取りやめた回</div>'+
          '<div class="row"></div></div>');
        i.skip.slice().sort().forEach(function(k){
          var b=h('<button class="act">'+escHtml(k)+' を戻す</button>');
          b.onclick=(function(id,key){ return function(){ unskipOccurrence(id,key); }; })(i.id,k);
          box.querySelector(".row").appendChild(b);
        });
        main.appendChild(box);
      }
    });
  });
  var all=h('<div style="margin:20px 0 0"><button class="act primary" style="padding:8px 14px">定期予定をまとめてカレンダーへ書き出す</button></div>');
  all.querySelector("button").onclick=function(){ downloadICS(list,"routines"); };
  main.appendChild(all);
}

function renderDone(){
  var list=db.items.filter(function(i){ return i.done; }).sort(sortByDue).reverse();
  main.appendChild(h('<div class="group-label">完了した締切</div>'));
  if(!list.length){ main.appendChild(h('<div class="empty"><b>まだありません</b>完了にした締切がここに残ります。</div>')); return; }
  list.forEach(function(i){ main.appendChild(cardOf(i)); });
}

function renderCal(){
  main.appendChild(filterBar());
  var y=calRef.getFullYear(), m=calRef.getMonth();
  var head=h('<div class="cal-head"><h2><span class="num">'+y+"."+pad(m+1)+'</span></h2><div class="row"></div></div>');
  var prev=h('<button class="nav">‹</button>'), today=h('<button class="nav" style="width:auto;padding:0 10px;font-size:12px">今月</button>'), next=h('<button class="nav">›</button>');
  prev.onclick=function(){ calRef=new Date(y,m-1,1); selDay=null; render(); };
  next.onclick=function(){ calRef=new Date(y,m+1,1); selDay=null; render(); };
  today.onclick=function(){ calRef=new Date(); selDay=null; render(); };
  head.querySelector(".row").append(prev,today,next);
  main.appendChild(head);

  // 定期予定の帯をまとめて出し入れする（この端末だけの表示設定）
  var showRoutine=store.get("cal-show-routine")!=="0";
  var rtToggle=h('<label class="cal-opt"><input type="checkbox"'+(showRoutine?" checked":"")+'>定期予定の帯を表示</label>');
  rtToggle.querySelector("input").onchange=function(){ store.set("cal-show-routine", this.checked?"1":"0"); render(); };
  main.appendChild(rtToggle);
  // 帯の色分け：カテゴリの色 / 締切の近さ（状態）の色（この端末だけの表示設定）
  var mode=calColorMode();
  var modeRow=h('<div class="cal-opt cal-mode">帯の色：</div>');
  [["cat","カテゴリ"],["status","締切の近さ"]].forEach(function(p){
    var b=h('<button type="button" class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", mode===p[0]?"true":"false");
    b.onclick=function(){ store.set("cal-color-mode", p[0]); render(); };
    modeRow.appendChild(b);
  });
  main.appendChild(modeRow);

  var grid=h('<div class="grid"></div>');
  DOW.forEach(function(d,i){ grid.appendChild(h('<div class="dow'+(i===0?" sun":i===6?" sat":"")+'">'+d+'</div>')); });
  var first=new Date(y,m,1), start=new Date(y,m,1-first.getDay());
  var gridEnd=new Date(start.getFullYear(),start.getMonth(),start.getDate()+41,23,59,59);
  // 繰り返しは表示範囲ぶんだけ展開する
  var items=[];
  db.items.filter(function(i){ return filter==="ALL"||i.cat===filter; })
    .forEach(function(i){ items=items.concat(expandOccurrences(i, start, gridEnd)); });
  var todayKey=toLocalISO(new Date());

  // その日が「締切日」か「期間の途中」かを判定する
  function hitsOn(key){
    return items.filter(function(i){
      var dueKey=toLocalISO(new Date(i.due));
      if(dueKey===key) return true;
      if(!i.start) return false;
      return key>=toLocalISO(new Date(i.start)) && key<dueKey;
    });
  }

  for(var k=0;k<42;k++){
    var d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+k);
    var key=toLocalISO(d);
    var hol=holidayName(key);
    var day=h('<button class="day'+(d.getMonth()!==m?" out":"")+(key===todayKey?" is-today":"")+(selDay===key?" sel":"")+(hol?" holiday":"")+'" '+
      (hol?'title="'+escHtml(hol)+'"':'')+'><span class="d">'+d.getDate()+'</span>'+
      (hol?'<span class="holname">'+escHtml(hol)+'</span>':'')+'</button>');
    // 帯：定期予定は、全体で隠しているときと、その予定だけ隠す設定のときは出さない
    var hit=hitsOn(key).filter(function(i){ return !isRepeating(i) || (showRoutine && !i.calHide); });
    hit.slice(0,3).forEach(function(i){
      var isDue=(toLocalISO(new Date(i.due))===key);
      // 定期予定は緑、それ以外は緊急度の色。期間の途中は薄い帯にする
      var cls=i.done?"done":(isRepeating(i)?"routine":statusOf(i));
      var style=(mode==="cat"&&!i.done)?' style="background:'+itemColor(i)+'"':'';
      day.appendChild(h('<span class="dot '+cls+(isDue?"":" span")+'"'+style+' title="'+escHtml(i.title+"（"+(i.cat||"その他")+"）")+'"></span>'));
    });
    (function(key){ day.onclick=function(){ selDay=(selDay===key?null:key); render(); }; })(key);
    grid.appendChild(day);
  }
  main.appendChild(grid);

  if(selDay){
    var sel=hitsOn(selDay).sort(sortByDue);
    var dd=new Date(selDay+"T00:00:00");
    var selHead=h('<div class="sel-title" style="display:flex;justify-content:space-between;align-items:center">'+(dd.getMonth()+1)+"月"+dd.getDate()+"日（"+DOW[dd.getDay()]+"）の予定"+
      '<button class="act">時間軸で見る</button></div>');
    selHead.querySelector("button").onclick=function(){ openDayView(selDay); };
    main.appendChild(selHead);
    if(!sel.length) main.appendChild(h('<div class="empty">この日の締切はありません。</div>'));
    else sel.forEach(function(i){ main.appendChild(cardOf(i)); });
  } else {
    main.appendChild(h('<div class="sel-title">日付をタップすると、その日の予定が出ます</div>'));
  }
}

/* サーバー上のindex.htmlを取り直し、ビルドスタンプを比較して表示する */
function checkVersionDisplay(section, myStamp){
  var el=section.querySelector("#verCheck");
  if(location.protocol==="file:"){ el.textContent="ローカルファイルのため確認できません。"; return; }
  fetch(location.pathname+"?_="+Date.now(),{cache:"no-store"})
    .then(function(res){ return res.ok?res.text():null; })
    .then(function(html){
      if(!html){ el.textContent="サーバーへ接続できませんでした。"; return; }
      var m=html.match(/<meta name="build-stamp" content="([^"]*)">/);
      var serverStamp=m?m[1]:"不明";
      if(serverStamp===myStamp){
        el.innerHTML='<span style="color:var(--blue)">✓ 最新版を表示しています</span>';
      } else {
        el.innerHTML='サーバー上の版：<b>'+escHtml(serverStamp)+'</b><br>'+
          '<span style="color:var(--red)">画面が古い可能性があります。強制リロード（Ctrl/⌘+Shift+R）するか、'+
          'URLの末尾に <code>?v=2</code> のように付けて開き直してください。</span>';
      }
    })
    .catch(function(){ el.textContent="確認に失敗しました。"; });
}

function renderSettings(){
  // このアプリが最新版かどうかを確認できるセクション
  var myStamp=(document.querySelector('meta[name="build-stamp"]')||{}).content||"不明";
  var s0=h('<div class="sec"><h3>バージョン</h3>'+
    '<p>この画面が読み込んでいる版：<b>'+escHtml(myStamp)+'</b></p>'+
    '<p id="verCheck" style="color:var(--ink-3)">サーバー上の版を確認しています…</p>'+
    '<div class="row"></div></div>');
  var bCheck=h('<button class="btn">今すぐ確認する</button>');
  bCheck.onclick=function(){ checkVersionDisplay(s0, myStamp); };
  s0.querySelector(".row").appendChild(bCheck);
  main.appendChild(s0);
  checkVersionDisplay(s0, myStamp);

  // 当日リマインド時刻
  var s1=h('<div class="sec"><h3>当日リマインドの時刻</h3><p>カレンダーに書き出すとき、締切当日の通知をこの時刻に入れます。1週間前・前日の通知は締切と同じ時刻に鳴ります。</p></div>');
  var sel=h('<select style="max-width:160px"></select>');
  for(var hh=5;hh<=22;hh++){ var o=document.createElement("option"); o.value=hh; o.textContent=hh+":00"; if(hh===db.settings.dayHour) o.selected=true; sel.appendChild(o); }
  sel.onchange=function(){ db.settings.dayHour=parseInt(sel.value,10); saveRaw(); toast("当日リマインドを "+sel.value+":00 にしました"); }; // 設定は同期対象外なのでupdatedAtは進めない
  s1.appendChild(sel); main.appendChild(s1);

  // テンプレート
  var sT=h('<div class="sec"><h3>テンプレート</h3>'+
    '<p>よく登録する締切の雛形です。締切カードの「雛形に保存」から作れます。登録画面で選ぶと内容が入ります（日付は毎回入力してください）。</p>'+
    '<div class="cat-list"></div></div>');
  var tplList=sT.querySelector(".cat-list");
  if(!db.templates.length){
    tplList.appendChild(h('<p style="font-size:12.5px;color:var(--ink-3);margin:0">まだありません。</p>'));
  } else {
    db.templates.forEach(function(t){
      var row=h('<div class="cat-row"><span class="cat-name">'+escHtml(t.name)+
        '<br><span style="font-size:11.5px;color:var(--ink-3)">'+escHtml(t.title)+'　'+escHtml(t.cat||"")+
        '　'+(t.allDay?"終日":escHtml(t.timeOfDay||"09:00"))+'</span></span>'+
        '<div class="cat-btns"></div></div>');
      var del=h('<button class="act" title="削除">×</button>');
      del.onclick=function(){
        if(!confirm("テンプレート「"+t.name+"」を削除します。よろしいですか？")) return;
        db.templates=db.templates.filter(function(x){ return x.id!==t.id; });
        save(); render(); toast("削除しました");
      };
      row.querySelector(".cat-btns").appendChild(del);
      tplList.appendChild(row);
    });
  }
  main.appendChild(sT);

  // ゴミ箱
  var trashSorted=db.trash.slice().sort(function(a,b){ return new Date(b.deletedAt)-new Date(a.deletedAt); });
  var sTr=h('<div class="sec"><h3>ゴミ箱</h3>'+
    '<p>削除した締切は30日間ここに残ります（最大30件）。一覧の「元に戻す」トーストは5秒で消えますが、こちらはいつでも復元できます。</p>'+
    '<div class="cat-list"></div></div>');
  var trList=sTr.querySelector(".cat-list");
  if(!trashSorted.length){
    trList.appendChild(h('<p style="font-size:12.5px;color:var(--ink-3);margin:0">ゴミ箱は空です。</p>'));
  } else {
    trashSorted.forEach(function(t){
      var d=new Date(t.deletedAt);
      var when=(d.getMonth()+1)+"/"+d.getDate()+" "+pad(d.getHours())+":"+pad(d.getMinutes())+" に削除";
      var row=h('<div class="cat-row"><span class="cat-name">'+escHtml(t.item.title)+
        '<br><span style="font-size:11.5px;color:var(--ink-3)">'+escHtml(when)+'</span></span>'+
        '<div class="cat-btns"></div></div>');
      var back=h('<button class="act" title="元に戻す">戻す</button>');
      back.onclick=function(){ restoreFromTrash(t.trashId); };
      var del=h('<button class="act" title="完全に削除">×</button>');
      del.onclick=function(){
        if(!confirm("「"+t.item.title+"」を完全に削除します。元に戻せません。よろしいですか？")) return;
        purgeTrashItem(t.trashId);
      };
      row.querySelector(".cat-btns").append(back,del);
      trList.appendChild(row);
    });
    var emptyBtn=h('<button class="act danger" style="margin-top:4px">ゴミ箱を空にする</button>');
    emptyBtn.onclick=purgeAllTrash;
    sTr.appendChild(emptyBtn);
  }
  main.appendChild(sTr);

  // 隔離（読み込み時に形式が不正で除外された項目）
  if(db.quarantine.length){
    var sQ=h('<div class="sec"><h3 style="color:var(--red)">隔離された項目（'+db.quarantine.length+'件）</h3>'+
      '<p>GitHubなどから読み込んだ内容のうち、必須項目（タイトル・締切日など）が壊れていたため取り込めなかったものです。「修復」で内容を直して保存すると一覧に戻ります。放置しても他の機能には影響しません。</p>'+
      '<div class="cat-list"></div></div>');
    var qList=sQ.querySelector(".cat-list");
    db.quarantine.forEach(function(q){
      var rawTitle=(q.raw&&typeof q.raw.title==="string")?q.raw.title:"(タイトル不明)";
      var row=h('<div class="cat-row"><span class="cat-name">'+escHtml(rawTitle)+
        '<br><span style="font-size:11.5px;color:var(--red)">'+escHtml(q.reason)+'</span></span>'+
        '<div class="cat-btns"></div></div>');
      var fix=h('<button class="act" title="修復して一覧に戻す">修復</button>');
      fix.onclick=function(){ openQuarantineFixDialog(q.qid); };
      var del=h('<button class="act" title="完全に削除">×</button>');
      del.onclick=function(){
        if(!confirm("この隔離項目を完全に削除します。よろしいですか？")) return;
        purgeQuarantineItem(q.qid);
      };
      row.querySelector(".cat-btns").append(fix,del);
      qList.appendChild(row);
    });
    main.appendChild(sQ);
  }

  // カテゴリ
  var s2=h('<div class="sec"><h3>カテゴリ</h3><p>登録画面の選択肢と、フィルタの並び順になります。左の色を押すと、36色のテンプレートかカラーコードで色を選べます（指定しなければ自動で割り振ります）。各カテゴリの「通知」で、カレンダー（.ics）の通知を何日前に鳴らすかを選べます（N日前は締切と同じ時刻、当日は「当日リマインドの時刻」）。</p><div class="cat-list"></div></div>');
  var line=s2.querySelector(".cat-list");
  db.categories.forEach(function(c,idx){
    var row=h('<div class="cat-row" style="flex-wrap:wrap"><span class="cat-name">'+escHtml(c)+'</span><div class="cat-btns"></div>'+
      '<div class="rem-row" style="flex-basis:100%;display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11.5px;color:var(--ink-3)">通知：</div></div>');
    var cur=remindersFor(c);
    REMINDER_CHOICES.forEach(function(n){
      var on=cur.indexOf(n)>=0;
      var b=h('<button class="chip" style="padding:1px 9px;font-size:11.5px">'+(n===0?"当日":n===1?"前日":n+"日前")+'</button>');
      b.setAttribute("aria-pressed", on?"true":"false");
      b.onclick=function(){
        var arr=remindersFor(c).slice();
        if(on) arr=arr.filter(function(x){ return x!==n; }); else arr.push(n);
        db.catReminders[c]=cleanCatReminders({v:arr}).v;
        save(); render(); scheduleAutoSync();
        toast("「"+c+"」の通知を変更しました。反映するには.icsを書き出し直してください");
      };
      row.querySelector(".rem-row").appendChild(b);
    });
    // 色：自動か、36色・カラーコードから選ぶ
    var cp=colorPicker({value:db.catColors[c]||null, autoColor:function(){ return autoColorMap()[c]||catColorRaw(c); }, autoText:"自動",
      onChange:function(v){
        if(v) db.catColors[c]=v; else delete db.catColors[c];
        save(); scheduleAutoSync(); render();
        toast(v?"「"+c+"」の色を "+v+" にしました":"「"+c+"」の色を自動に戻しました");
      }});
    cp.classList.add("cat-color");
    row.querySelector(".cat-name").before(cp);
    var btns=row.querySelector(".cat-btns");
    function mkBtn(label,title,disabled,fn){
      var b=h('<button class="act" title="'+title+'"'+(disabled?' disabled style="opacity:.3"':'')+'>'+label+'</button>');
      if(!disabled) b.onclick=fn;
      btns.appendChild(b);
    }
    mkBtn("↑","上へ移動",idx===0,function(){ moveCategory(idx,-1); });
    mkBtn("↓","下へ移動",idx===db.categories.length-1,function(){ moveCategory(idx,1); });
    mkBtn("×","削除",false,function(){
      if(db.categories.length<=1){ toast("カテゴリは1つ以上必要です"); return; }
      var used=db.items.filter(function(i){ return i.cat===c; }).length;
      var usedTpl=db.templates.filter(function(t){ return t.cat===c; }).length;
      var total=used+usedTpl;
      if(total && !confirm("「"+c+"」を使っている予定・テンプレートが"+total+"件あります。削除すると表示は残りますが、選択肢からは消えます。よろしいですか？")) return;
      db.categories=db.categories.filter(function(x){return x!==c;});
      delete db.catReminders[c];
      delete db.catColors[c];
      if(filter===c) filter="ALL";
      save(); render(); scheduleAutoSync();
    });
    line.appendChild(row);
  });
  var addRow=h('<div class="row"><input type="text" id="newCat" maxlength="20" placeholder="新しいカテゴリ名" style="flex:1;min-width:140px"><button class="btn">追加する</button></div>');
  addRow.querySelector("button").onclick=function(){
    var v=addRow.querySelector("input").value.trim();
    if(!v) return;
    if(db.categories.indexOf(v)>=0){ toast("同じ名前があります"); return; }
    db.categories.push(v); save(); render(); scheduleAutoSync();
  };
  s2.appendChild(addRow); main.appendChild(s2);

  // 表示
  var s3=h('<div class="sec"><h3>表示テーマ</h3><p>「自動」は端末の設定に合わせます。</p><div class="row"></div></div>');
  [["auto","自動"],["light","ライト"],["dark","ダーク"]].forEach(function(p){
    var b=h('<button class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", db.settings.theme===p[0]?"true":"false");
    b.onclick=function(){ db.settings.theme=p[0]; saveRaw(); applyTheme(); render(); }; // 設定は同期対象外なのでupdatedAtは進めない
    s3.querySelector(".row").appendChild(b);
  });
  main.appendChild(s3);

  // 完了の演出
  var s3b=h('<div class="sec"><h3>演出</h3><p>登録したときは「クエスト受注」、完了にしたときは「ミッション達成」、今日の締切を全部片付けたら「全クリア」（ボーナス +'+ALL_CLEAR_BONUS+' EXP）の帯を出します（タップですぐ閉じます）。延期・休み・削除のカードの動き、期限切れの点滅、数字の数え上げも、ここで止められます。端末で「視差効果を減らす」をオンにしている場合は出しません。<br>いまの記録：Lv.'+levelOf(totalExp())+'（累計 '+totalExp()+' EXP・完了 '+db.completions.length+' 件の記録）。記録は GitHub 同期で端末間に共有され、週次レビューにも載ります。</p><div class="row"></div></div>');
  [["on","あり"],["off","なし"]].forEach(function(p){
    var b=h('<button class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", (db.settings.motion||"on")===p[0]?"true":"false");
    b.onclick=function(){ db.settings.motion=p[0]; saveRaw(); render(); }; // 設定は同期対象外なのでupdatedAtは進めない
    s3b.querySelector(".row").appendChild(b);
  });
  main.appendChild(s3b);

  // 効果音
  var s3c=h('<div class="sec"><h3>効果音</h3><p>締切を登録・完了・削除したときに短い音を鳴らします。この端末だけの設定で、初めは「なし」です。端末がマナーモードのときや、ブラウザが音を許可していないときは鳴りません。</p><div class="row"></div></div>');
  [["on","あり"],["off","なし"]].forEach(function(p){
    var b=h('<button class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", (soundOn()?"on":"off")===p[0]?"true":"false");
    b.onclick=function(){
      db.settings.sound=p[0]; saveRaw(); render(); // 設定は同期対象外なのでupdatedAtは進めない
      if(p[0]==="on"){ unlockAudio(); playSfx("done"); } // 押した操作の中で鳴らして、音が出ることを確かめられるようにする
    };
    s3c.querySelector(".row").appendChild(b);
  });
  main.appendChild(s3c);

  // バックアップ
  var s4=h('<div class="sec"><h3>バックアップと復元</h3><p>データは端末ごとに保存されます。PCとiPhoneで同じ内容にしたいときは、書き出したファイルを読み込んでください。</p><div class="row"></div></div>');
  var bOut=h('<button class="btn">JSONで書き出す</button>');
  bOut.onclick=function(){
    var blob=new Blob([JSON.stringify(db,null,2)],{type:"application/json"});
    var url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download="deadline-backup-"+toLocalISO(new Date())+".json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(url);},1500);
    toast("バックアップを書き出しました");
  };
  var bIn=h('<button class="btn">JSONを読み込む</button>');
  var file=h('<input type="file" accept="application/json,.json" style="display:none">');
  bIn.onclick=function(){ file.click(); };
  file.onchange=function(){
    var f=file.files[0]; if(!f) return;
    var fr=new FileReader();
    fr.onload=function(){
      try{
        var d=JSON.parse(fr.result);
        if(!d||!Array.isArray(d.items)) throw 0;
        if(!confirm("読み込むと現在のデータは置き換わります。続けますか？")) return;
        // 手で編集したファイルなどで壊れた項目があっても、全体を読み込めるよう検証する
        var check=sanitizeIncomingItems(d.items);
        db.items=check.kept;
        if(check.quarantined.length) db.quarantine=db.quarantine.concat(check.quarantined);
        var meta=sanitizeIncomingMeta(d);
        if(meta.templates) db.templates=meta.templates;
        if(Array.isArray(d.trash)) db.trash=d.trash;
        if(meta.categories) db.categories=meta.categories;
        if(d.catReminders) db.catReminders=cleanCatReminders(d.catReminders);
        if(d.catColors) db.catColors=cleanCatColors(d.catColors);
        adoptCompletions(d);
        if(d.settings) db.settings=Object.assign(db.settings,d.settings);
        save(); applyTheme(); render();
        toast("読み込みました"+(check.quarantined.length?"（"+check.quarantined.length+"件は形式が不正のため隔離）":""));
      }catch(e){ toast("このファイルは読み込めません。書き出したJSONを選んでください"); }
      file.value="";
    };
    fr.readAsText(f);
  };
  var bIcs=h('<button class="btn">全件を.icsで書き出す</button>');
  bIcs.onclick=function(){ downloadICS(activeItems().sort(sortByDue),"deadlines-all"); };
  s4.querySelector(".row").append(bOut,bIn,bIcs,file);
  main.appendChild(s4);

  // 端末間の同期（GitHub）
  var s5=h('<div class="sec"><h3>端末間の同期とDiscord通知</h3>'+
    '<p>締切データ（data.json）をPrivateリポジトリに置き、端末間で受け渡します。<b>同期する</b>でこの端末の内容を送り、<b>読み込む</b>で他の端末から送られた内容を取り込みます。毎朝のDiscord送信も同じデータを見ています。</p>'+
    '<p style="font-size:12px;color:var(--ink-3)">トークンを保存している端末では、この端末に未同期の変更が無いときに限り、GitHub上の新しい内容を自動で取り込みます（読み込むボタンを押さなくても、他の端末の更新が反映されます）。この端末で先に変更していた場合は、自動では上書きしません。</p>'+
    '<div class="two"><label class="field"><span>GitHubユーザー名 / Organization</span><input type="text" id="ghOwner" placeholder="例：yamada-taro"></label>'+
    '<label class="field"><span>データ用リポジトリ名（Private推奨）</span><input type="text" id="ghRepo" placeholder="例：deadline-data"></label></div>'+
    '<label class="field"><span>ブランチ</span><input type="text" id="ghBranch" value="main"></label>'+
    '<label class="field"><span>Personal Access Token（Contents: Read and write）</span><input type="password" id="ghToken" placeholder="このリポジトリだけに絞ったトークンを推奨"></label>'+
    '<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-2);margin-bottom:12px">'+
    '<input type="checkbox" id="ghRemember" style="width:auto">この端末にトークンを保存して次回から入力を省く</label>'+
    '<p id="ghSecretNote" style="font-size:12.5px;color:var(--red);margin:-4px 0 12px"></p>'+
    '<div class="row"></div><p id="ghStatus" style="margin-top:8px"></p></div>');
  var g=function(id){ return s5.querySelector("#"+id); };
  var saved=JSON.parse(store.get("gh-sync")||"{}");
  var guess=guessRepoFromURL();
  g("ghOwner").value=saved.owner||guess.owner||"";
  g("ghRepo").value=saved.repo||guess.repo||"";
  g("ghBranch").value=saved.branch||"main";
  g("ghRemember").checked=!!store.get("gh-token");
  secretGet("gh-token").then(function(t){ // 暗号化して保存してあるので、復号できてから入れる（入力し始めていたら上書きしない）
    if(t && !g("ghToken").value) g("ghToken").value=t;
    if(!t) g("ghRemember").checked=false;
  });
  if(!saved.owner&&guess.owner) s5.querySelector("#ghStatus").textContent="保存先の候補として "+guess.owner+"/"+guess.repo+" を入れました。実際のPrivateリポジトリ名に合わせて直してください。";
  // このリポジトリが以前「Publicと承知の上」で確認済みなら、開くたびに気づけるよう常に出す
  if(saved.owner && saved.repo && ackedPublicRepo(saved.owner, saved.repo)){
    s5.insertBefore(
      h('<p style="font-size:12.5px;color:var(--red);margin:0 0 10px">⚠️ 同期先「'+escHtml(saved.owner)+'/'+escHtml(saved.repo)+'」はPublicリポジトリです。締切の内容が誰でも見られます。</p>'),
      s5.querySelector(".two")
    );
  }
  // 最後に同期した時刻。間が空いていると赤字にして気づけるようにする
  var ls=lastSyncText();
  var lsEl=h('<p style="font-size:12.5px;margin:0 0 12px;'+(ls&&ls.stale?'color:var(--red)':'color:var(--ink-2)')+'">'+
    (ls?('最終'+escHtml(ls.kind)+'：<b>'+escHtml(ls.rel)+'</b>　<span style="color:var(--ink-3)">'+escHtml(ls.text)+'</span>'
         +(ls.stale?'<br>しばらく同期されていません。登録した内容が毎朝の連絡に反映されていない可能性があります。':''))
        :'まだ一度も同期していません。')+'</p>');
  s5.insertBefore(lsEl, s5.querySelector(".two"));
  var bSync=h('<button class="btn fill">GitHubに同期する</button>');
  bSync.onclick=function(){ syncToGitHub(g,s5); };
  var bPull=h('<button class="btn">GitHubから読み込む</button>');
  bPull.onclick=function(){ pullFromGitHub(g,s5); };
  s5.querySelector(".row").append(bSync,bPull);
  main.appendChild(s5);

  // Discordへ今すぐ送る
  var s6=h('<div class="sec"><h3>Discordへ今すぐ送る</h3>'+
    '<p>毎朝の連絡を待たずに、今の締切一覧をDiscordへ送ります。通知先は上の同期設定を使って、Privateリポジトリの送信スクリプトから自動で読み取ります（別の宛先へ送りたいときだけ、下に直接入力してください）。</p>'+
    '<label class="field"><span>Discord Webhook URL（空欄でGitHubから自動取得）</span><input type="password" id="dcHook" placeholder="通常は空欄のままで大丈夫です"></label>'+
    '<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-2);margin-bottom:12px">'+
    '<input type="checkbox" id="dcRemember" style="width:auto">この端末に保存して次回から取得を省く</label>'+
    '<p id="dcSecretNote" style="font-size:12.5px;color:var(--red);margin:-4px 0 12px"></p>'+
    '<div class="row"></div><p id="dcStatus" style="margin-top:8px"></p></div>');
  s6.querySelector("#dcRemember").checked=!!store.get("dc-hook");
  secretGet("dc-hook").then(function(u){ // 暗号化して保存してあるので、復号できてから入れる（入力し始めていたら上書きしない）
    var box=s6.querySelector("#dcHook");
    if(u && !box.value) box.value=u;
    if(!u) s6.querySelector("#dcRemember").checked=false;
  });
  var bSend=h('<button class="btn fill">今すぐ送信</button>');
  bSend.onclick=function(){ sendToDiscord(s6,s5); };
  s6.querySelector(".row").appendChild(bSend);
  main.appendChild(s6);

  // 登録時の自動処理
  var s7=h('<div class="sec"><h3>登録したときの自動処理</h3>'+
    '<p>締切を登録・編集したときに、以下を自動で行います。上の設定が済んでいない場合は何も起きません。</p></div>');
  [["autoSync","GitHubへ自動で同期する","同期ボタンを押し忘れても、翌朝のDiscord通知に反映されます"],
   ["autoNotify","Discordへ自動で通知する","登録するたびにチャンネルへ送信されます（頻繁だと煩わしい場合があります）"]
  ].forEach(function(p){
    var wrap=h('<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-bottom:10px">'+
      '<input type="checkbox" style="width:auto;margin-top:3px">'+
      '<span>'+escHtml(p[1])+'<br><span style="font-size:11.5px;color:var(--ink-3)">'+escHtml(p[2])+'</span></span></label>');
    var cb=wrap.querySelector("input");
    cb.checked=!!db.settings[p[0]];
    cb.onchange=function(){ db.settings[p[0]]=cb.checked; saveRaw(); toast(cb.checked?"有効にしました":"無効にしました"); }; // 設定は同期対象外なのでupdatedAtは進めない
    s7.appendChild(wrap);
  });
  main.appendChild(s7);

  main.appendChild(h('<div class="sec"><h3>通知のしくみ</h3><p>このアプリ自体は通知を出しません。「カレンダーへ」で書き出した .ics を iPhone で開くと、標準カレンダーに予定と通知（1週間前・前日・当日）が登録され、アプリを閉じていても通知が届きます。締切の日時を変更したときは、もう一度書き出して取り込み直してください（同じ予定が上書きされます）。</p>'+
    '<p><b>iPhoneで取り込むときの注意：</b>Discordなどの添付ファイルを直接タップすると「照会カレンダー」として登録され、更新がすぐ反映されません。長押しして「ファイルに保存」してから開き、「カレンダーに追加」を選んでください。このアプリの「カレンダーへ」ボタンから書き出したファイルは、その心配がありません。</p></div>'));
}

/* 締切データの保存先リポジトリ名。Privateリポジトリを推奨（下のREADME参照） */
var DATA_REPO_NAME="deadline-data";

/* 公開URL（例：bibi257.github.io/deadline-tracker/）からownerを推定する */
function guessRepoFromURL(){
  var host=location.hostname;
  var m=host.match(/^([^.]+)\.github\.io$/);
  if(!m) return {};
  return {owner:m[1], repo:DATA_REPO_NAME};
}

/* 同期・読み込みで共通の入力チェック。問題なければ設定を返す */
/* 設定画面を開いていなくても使える、保存済みのGitHub設定の読み取り。
   トークンを保存していない端末では自動受け入れ機能自体が動かない（安全側） */
function getStoredGhConfig(){
  var saved=JSON.parse(store.get("gh-sync")||"{}");
  if(!saved.owner||!saved.repo) return Promise.resolve(null);
  return secretGet("gh-token").then(function(token){
    if(!token) return null;
    return {
      owner:saved.owner, repo:saved.repo, branch:saved.branch||"main",
      api:"https://api.github.com/repos/"+saved.owner+"/"+saved.repo+"/contents/data.json",
      headers:{"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json"}
    };
  });
}

/* この端末のデータが「前回GitHubと一致していた状態から何も変わっていない」ときだけ、
   GitHub上の新しい内容を自動で取り込む。
   ローカルにまだ送っていない変更がある場合は、データを失わないよう自動では上書きしない */
var _staleNoticeShown=false;
function autoPullIfStale(){
  // 同期の設定自体が無ければ何もしない
  return getStoredGhConfig().then(function(cfg){ return cfg ? autoPullWith(cfg) : undefined; }).catch(function(){});
}
function autoPullWith(cfg){
  var rawHeaders=Object.assign({}, cfg.headers, {"Accept":"application/vnd.github.raw"});
  return fetch(cfg.api+"?ref="+encodeURIComponent(cfg.branch)+"&_="+Date.now(), {headers:rawHeaders, cache:"no-store"})
    .then(function(res){
      if(!res.ok) return null; // 404やネットワーク不調などは静かに諦める(自動処理のため)
      return res.text();
    })
    .then(function(text){
      if(!text) return;
      var d;
      try{ d=JSON.parse(text); }catch(e){ return; }
      if(d && !Array.isArray(d.items) && d.content && d.encoding==="base64"){
        try{ d=JSON.parse(base64ToUtf8(d.content)); }catch(e){ return; }
      }
      // 比較に必要な情報(件数・時刻)が無いデータは判断できないので何もしない
      if(!d || !Array.isArray(d.items) || !d.updatedAt) return;

      var known=store.get("gh-known-updatedAt"); // 前回GitHubと一致していた時点の時刻
      var localAt=db.updatedAt;
      if(!known || !localAt) return; // 一度も同期していない端末は対象外(必ず手動の一回目を経由させる)

      var remoteChanged=(d.updatedAt>known);   // 前回同期時点からGitHub側が変わったか
      var localChanged=(localAt!==known);       // 前回同期時点からこの端末で変更したか
      if(!remoteChanged) return; // GitHub側に新しい内容が無ければ何もしない

      if(!localChanged){
        // ローカルは前回同期時点のまま変更されていない → 安全に取り込める
        var check=sanitizeIncomingItems(d.items);
        db.items=check.kept;
        if(check.quarantined.length) db.quarantine=db.quarantine.concat(check.quarantined);
        var meta=sanitizeIncomingMeta(d);
        if(meta.templates) db.templates=meta.templates;
        if(Array.isArray(d.trash)) db.trash=d.trash;
        if(meta.categories) db.categories=meta.categories;
        if(d.catReminders) db.catReminders=cleanCatReminders(d.catReminders);
        if(d.catColors) db.catColors=cleanCatColors(d.catColors);
        adoptCompletions(d);
        db.updatedAt=d.updatedAt;
        saveRaw(); softRender();
        markPulled();
        markSynced("自動反映");
        store.set("gh-known-updatedAt", d.updatedAt);
        toast("他の端末で更新された内容を自動で反映しました"+(check.quarantined.length?"（"+check.quarantined.length+"件は隔離）":""));
      } else if(!_staleNoticeShown){
        // 双方が前回同期後に変更されている(競合) → 自動上書きはしない。一度だけ知らせる
        _staleNoticeShown=true;
        toast("GitHubに新しい内容がありますが、この端末の未同期の変更を守るため自動反映していません");
      }
    })
    .catch(function(){});
}

/* リポジトリがPublicかどうかを確認する。締切の中身が世界中に見える事故を防ぐため。
   取得自体に失敗した場合は「わからない」を返し、同期は止めない（本来の機能を壊さないため） */
function checkRepoVisibility(cfg){
  return fetch("https://api.github.com/repos/"+cfg.owner+"/"+cfg.repo, {headers:cfg.headers, cache:"no-store"})
    .then(function(res){ return res.ok ? res.json() : null; })
    .then(function(j){ return j ? (j.private===false) : null; }) // true=Public, false=Private, null=不明
    .catch(function(){ return null; });
}
/* 「このリポジトリはPublicと承知の上」を記録し、次回から再警告しないようにする */
function ackedPublicRepo(owner,repo){
  var key="gh-public-acked";
  var list=JSON.parse(store.get(key)||"[]");
  return list.indexOf(owner+"/"+repo)>=0;
}
function ackPublicRepo(owner,repo){
  var key="gh-public-acked";
  var list=JSON.parse(store.get(key)||"[]");
  var id=owner+"/"+repo;
  if(list.indexOf(id)<0){ list.push(id); store.set(key, JSON.stringify(list)); }
}
/* 同期・読み込みの前にPublic確認を挟む。安全なら/確認済みなら resolve、
   ユーザーが中止すればrejectする */
function guardPublicRepo(cfg){
  if(ackedPublicRepo(cfg.owner,cfg.repo)) return Promise.resolve();
  return checkRepoVisibility(cfg).then(function(isPublic){
    if(isPublic===false) return; // Private なら先へ進む
    // Public、または判定できなかった（null）ときは確認する。判定できないまま黙って進めない
    var ok=confirm(isPublic===true
      ? "「"+cfg.owner+"/"+cfg.repo+"」はPublicリポジトリです。\n\n"+
        "締切の内容（タイトル・メモなど）が誰でも見られる状態になります。\n\n"+
        "本当にこのリポジトリを使い続けますか？"
      : "「"+cfg.owner+"/"+cfg.repo+"」の公開設定を確認できませんでした。\n\n"+
        "Publicなら、締切の内容（タイトル・メモなど）が誰でも見られる状態になります。\n\n"+
        "このまま続けますか？");
    if(!ok) return Promise.reject(new Error("__public_cancelled__"));
    if(isPublic===true) ackPublicRepo(cfg.owner,cfg.repo); // Publicと承知した場合だけ記録する
  });
}

function ghConfig(g,statusEl){
  var owner=g("ghOwner").value.trim(), repo=g("ghRepo").value.trim(),
      branch=g("ghBranch").value.trim()||"main", token=g("ghToken").value.trim();
  if(!owner||!repo||!token){ statusEl.textContent="ユーザー名・リポジトリ名・トークンをすべて入力してください。"; return null; }
  store.set("gh-sync", JSON.stringify({owner:owner,repo:repo,branch:branch}));
  if(g("ghRemember").checked){
    // 同期の結果表示に上書きされないよう、専用の欄に出す
    secretSet("gh-token", token).then(function(ok){
      g("ghSecretNote").textContent=ok?"":"この端末では暗号化して保存できないため、トークンは保存しませんでした（今回の操作だけに使います）。";
    });
  } else { secretDel("gh-token"); g("ghSecretNote").textContent=""; }
  return {
    owner:owner, repo:repo, branch:branch,
    api:"https://api.github.com/repos/"+owner+"/"+repo+"/contents/data.json",
    headers:{"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json"}
  };
}

/* エラー内容から、次にどうすればよいかを添える */
function ghHint(m){
  if(/does not match|conflict/i.test(m)) return "別の端末から同期された可能性があります。もう一度押してください。";
  if(/Bad credentials|401/i.test(m)) return "トークンが正しくないか、期限切れです。";
  if(/Not Found|404/i.test(m)) return "リポジトリ名か、トークンのRepository accessの設定を確認してください。";
  if(/403|permission|Resource not accessible/i.test(m)) return "トークンの権限（Contents: Read and write）を確認してください。";
  return "";
}

/* Privateリポジトリの send_digest.sh から Webhook URL を読み取る。
   同じURLを二度入力しなくて済むようにするための補助 */
function fetchWebhookFromRepo(g,statusEl){
  var cfg=ghConfig(g,statusEl);
  if(!cfg) return Promise.reject(new Error("設定が足りません"));
  var api="https://api.github.com/repos/"+cfg.owner+"/"+cfg.repo+
          "/contents/.github/scripts/send_digest.sh";
  var rawHeaders=Object.assign({}, cfg.headers, {"Accept":"application/vnd.github.raw"});
  return fetch(api+"?ref="+encodeURIComponent(cfg.branch)+"&_="+Date.now(),
               {headers:rawHeaders, cache:"no-store"})
    .then(function(res){
      if(res.status===404) throw new Error("send_digest.sh が見つかりません。");
      if(!res.ok) return res.json().then(function(e){ throw new Error(e.message||("HTTP "+res.status)); });
      return res.text();
    })
    .then(function(text){
      // APIのJSONが返った場合はbase64を展開してから探す
      if(text.charAt(0)==="{"){
        try{
          var j=JSON.parse(text);
          if(j.content&&j.encoding==="base64") text=base64ToUtf8(j.content);
        }catch(e){}
      }
      var m=text.match(/DEFAULT_WEBHOOK_URL\s*=\s*"([^"]+)"/);
      if(!m||!m[1]) throw new Error("スクリプト内にWebhook URLが見つかりません。");
      return m[1];
    });
}

/* Discordへ送る本文を組み立てる（毎朝のダイジェストと同じ書式に揃える） */
function buildDigestText(){
  var now=new Date();
  var win=new Date(now.getTime()+7*86400000);
  var all=activeItems().filter(function(i){ return !isRepeating(i); });
  // 期限切れには、完了にし忘れた定期予定の回も含める（毎朝の通知と同じ扱い）
  var over=activeItems().filter(function(i){ return parseItemDate(i)<now; }).sort(sortByDue);
  var today=all.filter(function(i){ return parseItemDate(i)>=now && daysBetween(now,refDate(i))===0; }).sort(sortByDue);
  var soon=all.filter(function(i){ var n=daysBetween(now,refDate(i)); return parseItemDate(i)>=now && n>0 && refDate(i)<=win; }).sort(sortByDue);
  var reps=activeItems().filter(isRepeating).sort(sortByDue);

  function line(i){
    var d=parseItemDate(i);
    var when=i.start?(fmtDue(new Date(i.start),i.allDay)+" 〜 "+fmtDue(d,i.allDay)):fmtDue(d,i.allDay);
    var r=remainText(i);
    return "- "+(isRepeating(i)?"🔁 ":"")+"**"+i.title+"**　`"+(i.cat||"その他")+"`\n  "+when+"　── "+r.n+" "+r.u;
  }

  var t="# 📋 締切トラッカー\n";
  t+="### "+(now.getMonth()+1)+"月"+now.getDate()+"日（"+DOW[now.getDay()]+"）の連絡\n";

  // 長く放置されているものは冒頭で警告する。多すぎると麻痺するので上位3件まで
  var stale=over.filter(isStale).sort(function(a,b){ return overdueDays(b)-overdueDays(a); });
  if(stale.length){
    t+="\n## ⚠️ 長く残っています（"+stale.length+"件）\n";
    stale.slice(0,3).forEach(function(i){
      t+="- "+(isRepeating(i)?"🔁 ":"")+"**"+i.title+"**　`"+(i.cat||"その他")+"`\n  "+fmtDue(parseItemDate(i),i.allDay)+" 締切 ── "+overdueDays(i)+"日経過\n";
    });
    if(stale.length>3) t+="-# ほか "+(stale.length-3)+" 件\n";
    t+="-# 完了か削除をおすすめします\n";
  }

  if(over.length){
    t+="\n## 🔴 期限切れ（"+over.length+"件）\n";
    over.forEach(function(i){ t+=line(i)+"\n"; });
  }
  if(today.length){
    t+="\n## ⚡ 今日が締切（"+today.length+"件）\n";
    today.forEach(function(i){ t+=line(i)+"\n"; });
  }

  t+="\n## ⏳ 7日以内の締切"+(soon.length?"（"+soon.length+"件）":"")+"\n";
  if(soon.length) soon.forEach(function(i){ t+=line(i)+"\n"; });
  else t+="-# 予定はありません\n";

  if(reps.length){
    var labels={weekly:"毎週",biweekly:"隔週",monthly:"毎月",yearly:"毎年"};
    // 締切が過ぎたままの回があっても、「次は」には今より先の回を出す
    var nexts=reps.map(function(i){ return {i:i, n:upcomingDue(i)}; })
      .sort(function(a,b){ return (a.n?a.n.getTime():Infinity)-(b.n?b.n.getTime():Infinity); });
    t+="\n## 🔁 定期予定\n";
    nexts.forEach(function(x){
      var i=x.i, days=x.n?daysBetween(now,x.n):null;
      t+="- **"+i.title+"**　`"+(i.cat||"その他")+"`　"+(labels[i.rep]||i.rep)+"\n"+
         (x.n ? "  次は "+fmtDue(x.n,i.allDay)+"　── "+(days===0?"今日":days+" 日後")+"\n"
              : "  -# 予定していた回数をすべて終えました\n");
    });
  }

  var url=location.origin+location.pathname;
  t+="\n## 🔗 リンク\n";
  t+="- [アプリを開く]("+url+")\n";
  t+="- [カレンダーに入れる]("+url+"?export=all)\n";
  return t;
}

/* 入力されたWebhookへ、いまの締切一覧を送信する。
   未入力の場合は、Privateリポジトリのスクリプトから自動で取得する */
function sendToDiscord(s6,s5){
  var statusEl=s6.querySelector("#dcStatus");
  // コピー時に混ざりやすい空白・引用符・末尾のスラッシュを取り除く
  var hook=s6.querySelector("#dcHook").value.trim().replace(/^["'<]+|[">'\s]+$/g,"").replace(/\/+$/,"");

  function post(url){
    statusEl.textContent="送信しています…";
    var text=fitDiscord(buildDigestText());
    return fetch(url,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:text})
    })
    .then(function(res){
      if(res.ok||res.status===204){
        statusEl.textContent="送信しました。";
        toast("Discordへ送信しました");
        return;
      }
      if(res.status===429){ statusEl.textContent="送信が多すぎます。少し待ってからもう一度お試しください。"; return; }
      if(res.status===401||res.status===404){
        statusEl.textContent="Webhook URLが無効です。Discord側で削除されていないか、URLが最後まで正しくコピーされているか確認してください。"; return;
      }
      // 400などはDiscordが理由を返すので、そのまま見せる
      return res.text().then(function(t){
        var detail=t;
        try{ var j=JSON.parse(t); detail=j.message||JSON.stringify(j); }catch(e){}
        statusEl.textContent="送信に失敗しました（HTTP "+res.status+"）："+String(detail).slice(0,200);
      });
    })
    .catch(function(){
      statusEl.textContent="送信に失敗しました。通信状況を確認してください。";
    });
  }

  if(hook){
    if(!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook)){
      statusEl.textContent="DiscordのWebhook URLの形式ではありません。"; return;
    }
    var note=s6.querySelector("#dcSecretNote");
    if(s6.querySelector("#dcRemember").checked){
      // 送信結果の表示に上書きされないよう、専用の欄に出す
      secretSet("dc-hook", hook).then(function(ok){
        note.textContent=ok?"":"この端末では暗号化して保存できないため、Webhook URLは保存しませんでした（今回の送信だけに使います）。";
      });
    } else { secretDel("dc-hook"); note.textContent=""; }
    post(hook);
    return;
  }

  // 未入力：上のGitHub設定を使ってスクリプトからURLを取り出す
  statusEl.textContent="GitHubから通知先を取得しています…";
  var g=function(id){ return s5.querySelector("#"+id); };
  fetchWebhookFromRepo(g,statusEl)
    .then(function(url){
      // 保存はしない。この端末に保存するかは「この端末に保存」の選択に任せる（URLはGitHubのスクリプトが持つ）
      s6.querySelector("#dcHook").value=url;
      return post(url);
    })
    .catch(function(err){
      var m=err.message||"";
      statusEl.textContent="通知先を取得できませんでした："+m+
        "　→ 上の同期設定（ユーザー名・リポジトリ名・トークン）を確認するか、Webhook URLを直接入力してください。";
    });
}

/* カテゴリの並び順を1つ入れ替える */
function moveCategory(idx, dir){
  var to=idx+dir;
  if(to<0||to>=db.categories.length) return;
  var arr=db.categories;
  var tmp=arr[idx]; arr[idx]=arr[to]; arr[to]=tmp;
  save(); render(); scheduleAutoSync(); // 並び順で自動の色が決まるので、他の端末にも送る
}

/* GitHubのdata.jsonを読み込んで、この端末のデータを置き換える */
function pullFromGitHub(g,s5){
  var statusEl=s5.querySelector("#ghStatus");
  var cfg=ghConfig(g,statusEl);
  if(!cfg) return;

  statusEl.textContent="リポジトリの公開設定を確認しています…";
  guardPublicRepo(cfg).then(function(){
    proceedPull(cfg,statusEl);
  }).catch(function(err){
    if(err&&err.message==="__public_cancelled__"){
      statusEl.textContent="読み込みを中止しました。";
    } else {
      proceedPull(cfg,statusEl);
    }
  });
}

function proceedPull(cfg,statusEl){
  statusEl.textContent="読み込んでいます…";
  // Acceptを後から上書きしてファイル本文を直接受け取る（順序を逆にすると効かない）
  var rawHeaders=Object.assign({}, cfg.headers, {"Accept":"application/vnd.github.raw"});
  fetch(cfg.api+"?ref="+encodeURIComponent(cfg.branch)+"&_="+Date.now(),
        {headers:rawHeaders, cache:"no-store"})
    .then(function(res){
      if(res.status===404) throw new Error("data.json がまだありません。先にPCなどで「GitHubに同期する」を実行してください。");
      if(!res.ok) return res.json().then(function(e){ throw new Error(e.message||("HTTP "+res.status)); });
      return res.text();
    })
    .then(function(text){
      var d=JSON.parse(text);
      // rawが効かずAPIのJSONが返った場合は、base64の中身を取り出す
      if(d && !Array.isArray(d.items) && d.content && d.encoding==="base64"){
        d=JSON.parse(base64ToUtf8(d.content));
      }
      if(!d||!Array.isArray(d.items)) throw new Error("データの形式が読み取れません。");
      var check=sanitizeIncomingItems(d.items);
      var n=check.kept.length;
      if(db.items.length && !confirm("この端末の締切"+db.items.length+"件を、GitHub上の"+n+"件で置き換えます。よろしいですか？")){
        statusEl.textContent="読み込みを中止しました。";
        return;
      }
      db.items=check.kept;
      if(check.quarantined.length){
        db.quarantine=db.quarantine.concat(check.quarantined);
      }
      var meta=sanitizeIncomingMeta(d);
      if(meta.templates) db.templates=meta.templates;
      if(Array.isArray(d.trash)) db.trash=d.trash;
      if(meta.categories) db.categories=meta.categories;
      if(d.catReminders) db.catReminders=cleanCatReminders(d.catReminders);
        if(d.catColors) db.catColors=cleanCatColors(d.catColors);
      adoptCompletions(d);
      // 取り込んだ内容の時刻をそのまま引き継ぐ（今の時刻で上書きすると比較の基準が壊れるため）
      db.updatedAt=d.updatedAt||new Date().toISOString();
      saveRaw(); render();
      markSynced("読み込み");
      markPulled();
      store.set("gh-known-updatedAt", db.updatedAt); // GitHub側もこの時刻の内容と一致した
      statusEl.textContent="読み込みました（"+n+"件）。"+(check.quarantined.length?(" "+check.quarantined.length+"件は形式が不正のため隔離しました（設定タブで確認できます）。"):"");
      toast("GitHubから"+n+"件を読み込みました"+(check.quarantined.length?"（"+check.quarantined.length+"件は隔離）":""));
    })
    .catch(function(err){
      var m=err.message||"";
      var hint=ghHint(m);
      statusEl.textContent="読み込みに失敗しました："+m+(hint?"　→ "+hint:"");
    });
}

/* GitHubのContents APIでdata.jsonを作成/更新する */
function utf8ToBase64(str){
  var bytes=new TextEncoder().encode(str), bin="";
  bytes.forEach(function(b){ bin+=String.fromCharCode(b); });
  return btoa(bin);
}
/* GitHub APIが返すbase64を、日本語が壊れないように文字列へ戻す */
function base64ToUtf8(b64){
  var bin=atob(String(b64).replace(/\s/g,""));
  var bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
function syncToGitHub(g,s5){
  var statusEl=s5.querySelector("#ghStatus");
  var cfg=ghConfig(g,statusEl);
  if(!cfg) return;

  statusEl.textContent="リポジトリの公開設定を確認しています…";
  guardPublicRepo(cfg).then(function(){
    proceedSync(cfg,statusEl);
  }, function(err){
    // 中止したとき、または公開設定を確かめられなかったときは送らない（公開されるかもしれない内容を送らない）
    statusEl.textContent=(err&&err.message==="__public_cancelled__")
      ? "同期を中止しました。"
      : "公開設定を確認できなかったため、同期を中止しました。";
  });
}

function proceedSync(cfg,statusEl){
  // この端末がGitHub上のデータを24時間以上取得していない場合、
  // 他の端末で更新された内容を上書きしてしまう恐れがあるので確認を挟む
  var hours=hoursSincePulled();
  if(hours!==null && hours>=24){
    var days=Math.floor(hours/24);
    var ok=confirm(
      "この端末が最後にGitHubの内容を取得してから "+days+"日以上 経っています。\n\n"+
      "他の端末で登録・更新した内容があると、今の同期でそれが上書きされて消える可能性があります。\n\n"+
      "続ける前に、今GitHub上にある内容をバックアップとして保存します。よろしいですか？"
    );
    if(!ok){ statusEl.textContent="同期を中止しました。心配な場合は先に「GitHubから読み込む」をお試しください。"; return; }
    statusEl.textContent="安全のため、現在の内容をバックアップしています…";
    backupRemoteBeforeOverwrite(cfg).then(function(){ doSync(cfg,statusEl,true); });
    return;
  }
  doSync(cfg,statusEl,false);
}

/* 上書きされてしまう前に、GitHub上の現在の内容を別ファイルとして保存しておく */
function backupRemoteBeforeOverwrite(cfg){
  return fetch(cfg.api+"?ref="+encodeURIComponent(cfg.branch)+"&_="+Date.now(),
               {headers:Object.assign({},cfg.headers,{"Accept":"application/vnd.github.raw"}), cache:"no-store"})
    .then(function(res){ return res.ok ? res.text() : null; })
    .then(function(text){
      if(!text) return; // 既存データが無ければバックアップ不要
      // rawが効かずAPIのJSON(sha等を含む)が返ることがあるため、その場合は中身を取り出す
      if(text.charAt(0)==="{"){
        try{
          var j=JSON.parse(text);
          if(j.content&&j.encoding==="base64") text=base64ToUtf8(j.content);
        }catch(e){}
      }
      var stamp=new Date().toISOString().replace(/[:T]/g,"-").slice(0,16);
      var path="backups/data-"+stamp+".json";
      var bak=utf8ToBase64(text);
      var api="https://api.github.com/repos/"+cfg.owner+"/"+cfg.repo+"/contents/"+path;
      return fetch(api,{method:"PUT",
        headers:Object.assign({"Content-Type":"application/json"},cfg.headers),
        body:JSON.stringify({message:"上書き前の自動バックアップ", content:bak, branch:cfg.branch})
      }).catch(function(){}); // バックアップに失敗しても同期自体は止めない
    })
    .catch(function(){});
}

function doSync(cfg,statusEl,backedUp){
  statusEl.textContent="同期しています…";
  var api=cfg.api, branch=cfg.branch, headers=cfg.headers;
  // 一度も保存していない端末はupdatedAtが無いので、送る直前に確定させる
  if(!db.updatedAt) db.updatedAt=new Date().toISOString();
  var pushedAt=db.updatedAt; // 送信中の編集に影響されないよう、送った時点の値を捕捉
  var payload=syncPayload(); // 自動同期と同じ内容を送る（以前は catReminders が抜けていた）
  var content=utf8ToBase64(JSON.stringify(payload,null,2));

  function put(sha){
    var body={ message:"締切データを同期（"+new Date().toLocaleString("ja-JP")+"）",
               content:content, branch:branch };
    if(sha) body.sha=sha;
    return fetch(api,{method:"PUT",
      headers:Object.assign({"Content-Type":"application/json"},headers),
      body:JSON.stringify(body)});
  }

  // GitHub上に、この端末が取り込んでいない他の端末の更新がある場合は、上書き前に確認する
  // （24時間以内に取得していても、その後に別の端末が同期していれば消えてしまうため）
  fetchRemoteState(cfg)
    .then(function(r){
      if(backedUp || !remoteHasUnknownChanges(r)) return r.sha;
      var ok=confirm(
        "GitHub上に、この端末がまだ読み込んでいない新しい内容があります（他の端末で同期された可能性があります）。\n\n"+
        "このまま同期すると、その内容はこの端末の内容で上書きされます。\n"+
        "上書き前の内容は backups/ に保存します。続けますか？\n\n"+
        "（先に他の端末の内容を取り込みたい場合は「キャンセル」→「GitHubから読み込む」）"
      );
      if(!ok) throw new Error("__sync_cancelled__");
      return backupRemoteBeforeOverwrite(cfg).then(function(){ return r.sha; });
    })
    .then(put)
    .then(function(res){
      if(res.status===409){ // 版が競合したら、他端末の更新を確認し直してから1度だけやり直す（自動同期と同じ）
        return fetchRemoteState(cfg).then(function(r){
          if(remoteHasUnknownChanges(r)) throw new Error("__sync_cancelled__");
          return put(r.sha);
        });
      }
      return res;
    })
    .then(function(res){
      if(!res.ok) return res.json().then(function(e){ throw new Error(e.message||("HTTP "+res.status)); });
      markSynced("同期");
      markPulled(); // 自分が今アップロードした内容＝この端末の最新状態、として扱う
      store.set("gh-known-updatedAt", pushedAt); // GitHub側もこの時刻の内容と一致した
      statusEl.textContent="同期しました。次の朝のダイジェストから反映されます。";
      toast("GitHubに同期しました");
    })
    .catch(function(err){
      var m=err.message||"";
      if(m==="__sync_cancelled__"){ statusEl.textContent="同期を中止しました。「GitHubから読み込む」で他の端末の内容を取り込めます。"; return; }
      var hint=ghHint(m);
      statusEl.textContent="同期に失敗しました："+m+(hint?"　→ "+hint:"");
    });
}

/* ========== 登録・編集 ========== */
var dlg=document.getElementById("dlg"), dlgForm=document.getElementById("dlgForm");
dlg.addEventListener("close",function(){
  // キャンセル等で閉じた場合、隔離修復中の状態が残っているとバグの元になるためリセットする
  // (保存成功時は既にnullにしている。ここで消えるのは「修復せず閉じた」場合のみ)
  fixingQuarantineId=null;
  fromQuick=false;
});
function openDialog(item){
  editingId=item?item.id:null;
  document.getElementById("dlgTitle").textContent=item?"締切を編集":"締切を登録";
  var catSel=document.getElementById("fCat");
  catSel.innerHTML="";
  db.categories.forEach(function(c){ var o=document.createElement("option"); o.value=c; o.textContent=c; catSel.appendChild(o); });

  // テンプレート欄は新規登録のときだけ出す（編集中に入れ替わると混乱するため）
  var tplRow=document.getElementById("tplRow"), tplSel=document.getElementById("fTpl");
  if(!item && db.templates.length){
    tplRow.style.display="";
    tplSel.innerHTML="";
    var none=document.createElement("option"); none.value=""; none.textContent="（使わない）"; tplSel.appendChild(none);
    db.templates.forEach(function(t){
      var o=document.createElement("option"); o.value=t.id; o.textContent=t.name; tplSel.appendChild(o);
    });
    tplSel.value="";
    tplSel.onchange=function(){ applyTemplate(tplSel.value); };
  } else {
    tplRow.style.display="none";
  }
  if(item){
    var d=parseItemDate(item);
    document.getElementById("fTitle").value=item.title;
    document.getElementById("fDate").value=toLocalISO(d);
    document.getElementById("fTime").value=pad(d.getHours())+":"+pad(d.getMinutes());
    catSel.value=item.cat||db.categories[0];
    document.getElementById("fRep").value=item.rep||"none";
    setRepCountValue(item.repCount==null?15:item.repCount);
    document.getElementById("fMemo").value=item.memo||"";
    document.getElementById("fAllDay").checked=!!item.allDay;
    document.getElementById("fAutoComplete").checked=!!item.autoComplete;
    document.getElementById("fCalShow").checked=!item.calHide;
    var hasStart=!!item.start;
    document.getElementById("fSpan").checked=hasStart;
    if(hasStart){
      var s=new Date(item.start);
      document.getElementById("fStart").value=toLocalISO(s);
      document.getElementById("fStartTime").value=pad(s.getHours())+":"+pad(s.getMinutes());
    }
  } else {
    dlgForm.reset();
    var base=selDay?new Date(selDay+"T00:00:00"):new Date();
    document.getElementById("fDate").value=toLocalISO(base);
    document.getElementById("fTime").value="09:00";
    document.getElementById("fStart").value=toLocalISO(base);
    document.getElementById("fStartTime").value="09:00";
    setRepCountValue(15);
    catSel.value=(filter!=="ALL"&&db.categories.indexOf(filter)>=0)?filter:db.categories[0];
  }
  // 色：既定はカテゴリの色。この締切だけ別の色にもできる
  dlgColor=item?(normHex(item.color)||null):null;
  var host=document.getElementById("fColorHost"); host.innerHTML="";
  var cp=colorPicker({value:dlgColor, autoColor:function(){ return catColorRaw(catSel.value); }, autoText:"カテゴリの色", autoLabel:"カテゴリの色に戻す",
    onChange:function(v){ dlgColor=v; }});
  host.appendChild(cp);
  dlgColorPicker=cp;
  catSel.onchange=function(){ cp.refresh(); };
  syncDialogRows();
  dlg.showModal();
}
var dlgColor=null, dlgColorPicker=null;
/* テンプレート・自然文入力・修復などでカテゴリ欄を書き換えたあと、色の表示を合わせる */
function refreshDlgColor(v){
  if(v!==undefined){ dlgColor=normHex(v)||null; if(dlgColorPicker) dlgColorPicker.setValue(dlgColor); }
  else if(dlgColorPicker) dlgColorPicker.refresh();
}

/* 繰り返し回数の選択肢に値を入れる。完了で残り回数が減ると選択肢に無い数(14回など)になり、
   そのまま保存すると回数が壊れる(NaN)ため、無い数は「残りN回」として一時的に選択肢へ足す */
function setRepCountValue(n){
  var sel=document.getElementById("fRepCount");
  Array.prototype.slice.call(sel.querySelectorAll("option[data-extra]")).forEach(function(o){ o.remove(); });
  var v=String(n);
  if(!sel.querySelector('option[value="'+v+'"]')){
    var o=document.createElement("option");
    o.value=v; o.textContent="残り"+v+"回"; o.setAttribute("data-extra","1");
    sel.insertBefore(o, sel.firstChild);
  }
  sel.value=v;
}

/* チェックや選択に応じて、関係のある入力欄だけを出す */
function syncDialogRows(){
  var span=document.getElementById("fSpan").checked;
  document.getElementById("startRow").style.display=span?"":"none";
  document.getElementById("dueLabel").textContent=span?"終了日":"締切日";
  var rep=document.getElementById("fRep").value;
  document.getElementById("repCountRow").style.display=(rep==="none")?"none":"";
  document.getElementById("calShowRow").style.display=(rep==="none")?"none":"flex";
  // 終日のときは時刻欄を隠す
  var allDay=document.getElementById("fAllDay").checked;
  var dueCell=document.querySelector(".dueTimeCell"), startCell=document.querySelector(".startTimeCell");
  dueCell.style.display=allDay?"none":"";
  startCell.style.display=allDay?"none":"";
  document.getElementById("fTime").required=!allDay;

  // 締切日が土日祝なら知らせる（登録は妨げない）
  var note=document.getElementById("dayOffNote");
  var dv=document.getElementById("fDate").value;
  note.style.display="none";
  if(dv){
    var dd=new Date(dv+"T00:00:00");
    var hol=holidayName(dv);
    if(hol){ note.textContent="⚠️ この日は祝日です（"+hol+"）"; note.style.display=""; }
    else if(dd.getDay()===0){ note.textContent="⚠️ この日は日曜です"; note.style.display=""; }
    else if(dd.getDay()===6){ note.textContent="⚠️ この日は土曜です"; note.style.display=""; }
  }
  updateOverlapNote();
}

/* 入力中の日時と同じ時間帯に他の予定があれば知らせる（登録は妨げない）。
   判定は時刻のある予定どうしだけ。終日・数日にまたがる期間は対象外 */
function updateOverlapNote(){
  var note=document.getElementById("overlapNote");
  note.style.display="none";
  var dv=document.getElementById("fDate").value;
  if(!dv || document.getElementById("fAllDay").checked) return;
  var end=new Date(dv+"T"+(document.getElementById("fTime").value||"09:00")+":00");
  var start=new Date(end.getTime()-EVENT_MINUTES*60000);
  if(document.getElementById("fSpan").checked){
    var sd=document.getElementById("fStart").value;
    if(sd){
      if(sd!==dv) return; // 日をまたぐ期間は対象外
      start=new Date(sd+"T"+(document.getElementById("fStartTime").value||"09:00")+":00");
    }
  }
  if(isNaN(end.getTime()) || isNaN(start.getTime()) || start>=end) return;
  var hits=findOverlaps({start:start,end:end}, dv, editingId);
  if(!hits.length) return;
  var names=hits.slice(0,3).map(function(i){
    var r=timeRangeOf(i);
    return "「"+i.title+"」"+(i.start?fmtTime(r.start)+"–":"")+fmtTime(r.end);
  }).join("、");
  note.textContent="⚠️ この時間帯には他の予定があります："+names+(hits.length>3?" ほか"+(hits.length-3)+"件":"");
  note.style.display="";
}
document.getElementById("fDate").addEventListener("change",syncDialogRows);
["fTime","fStart","fStartTime"].forEach(function(id){ document.getElementById(id).addEventListener("change",updateOverlapNote); });
document.getElementById("fSpan").addEventListener("change",syncDialogRows);
document.getElementById("fAllDay").addEventListener("change",syncDialogRows);
document.getElementById("fRep").addEventListener("change",syncDialogRows);

dlgForm.addEventListener("submit",function(e){
  var val=e.submitter?e.submitter.value:"save";
  if(val!=="save") return;
  var title=document.getElementById("fTitle").value.trim();
  var date=document.getElementById("fDate").value;
  var allDay=document.getElementById("fAllDay").checked;
  var autoComplete=document.getElementById("fAutoComplete").checked;
  // 終日は内部的に「その日の23:59」を締切として扱い、表示では時刻を出さない
  var time=allDay?"23:59":(document.getElementById("fTime").value||"09:00");
  if(!title||!date){
    e.preventDefault();
    if(!date) toast("締切日を入力してください");
    return;
  }
  var due=new Date(date+"T"+time+":00");

  var start=null;
  if(document.getElementById("fSpan").checked){
    var sd=document.getElementById("fStart").value;
    var st=allDay?"00:00":(document.getElementById("fStartTime").value||"09:00");
    if(sd){
      start=new Date(sd+"T"+st+":00");
      if(start>due){ e.preventDefault(); toast("開始が終了より後になっています"); return; }
    }
  }
  var rep=document.getElementById("fRep").value;
  var repCount=(rep==="none")?0:(parseInt(document.getElementById("fRepCount").value,10)||0);
  // カレンダーの帯を出さない設定は、繰り返しの締切にだけ持たせる
  var calHide=(rep!=="none") && !document.getElementById("fCalShow").checked;

  if(editingId){
    var found=false;
    db.items.forEach(function(i){
      if(i.id!==editingId) return;
      found=true;
      i.title=title; i.due=due.toISOString(); i.cat=document.getElementById("fCat").value;
      i.rep=rep; i.repCount=repCount; i.memo=document.getElementById("fMemo").value.trim();
      if(allDay) i.allDay=true; else delete i.allDay;
      if(autoComplete) i.autoComplete=true; else delete i.autoComplete;
      if(calHide) i.calHide=true; else delete i.calHide;
      if(dlgColor) i.color=dlgColor; else delete i.color;
      if(start) i.start=start.toISOString(); else delete i.start;
      delete i.repDay; // 締切日を選び直したので、月末丸めの基準日も新しい日付から取り直す
      i.seq=(i.seq||0)+1;
    });
    if(found){
      toast("更新しました。通知を変えるには.icsを取り込み直してください");
    } else {
      // 自動反映などで、編集中にこの締切が他の端末から削除されていた場合
      toast("この締切は他の端末で削除されていたため、更新できませんでした");
    }
  } else {
    var it={
      id:"d"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      title:title, due:due.toISOString(), cat:document.getElementById("fCat").value,
      rep:rep, repCount:repCount, memo:document.getElementById("fMemo").value.trim(),
      done:false, created:new Date().toISOString()
    };
    if(start) it.start=start.toISOString();
    if(allDay) it.allDay=true;
    if(autoComplete) it.autoComplete=true;
    if(calHide) it.calHide=true;
    if(dlgColor) it.color=dlgColor;
    db.items.push(it);
    justAddedId=it.id;
    playSfx("add");
    if(motionOn()) playQuestAccept(it);
    else toast(rep==="none"?"登録しました":"登録しました。繰り返しの回もカレンダーに出ます");
    // 隔離項目の修復中だった場合は、保存できたので隔離から取り除く
    if(fixingQuarantineId!==null){
      var fq=fixingQuarantineId;
      db.quarantine=db.quarantine.filter(function(q){ return q.qid!==fq; });
      fixingQuarantineId=null;
      toast("修復して一覧に戻しました");
    }
  }
  if(fromQuick){ quickText=""; fromQuick=false; }
  save(); render();
  highlightJustAdded();
  autoSyncIfConfigured();
  autoNotifyIfConfigured();
});

function applyCompletion(it, source){
  var log=logCompletion(it, source||"manual");
  var r=applyCompletionCore(it);
  r.log=log;
  if(!r.repeating || r.final) it.doneLog=log.id; // 「戻す」で記録も取り消せるよう、対応を残す
  return r;
}
/* 完了を記録する。EXPは期限より前に終えるほど多い。自動完了は記録だけでEXPは付けない */
function logCompletion(it, source){
  var now=new Date(), due=parseItemDate(it), hours=(due-now)/3600000, kind, exp;
  if(source==="auto"){ kind="auto"; exp=0; }
  else if(hours<0){ kind="late"; exp=5; }
  else if(hours<24){ kind="ontime"; exp=10; }
  else { kind="early"; exp=10+Math.min(40, 5*Math.floor(hours/24)); }
  var c={id:"c"+now.getTime().toString(36)+Math.random().toString(36).slice(2,6), itemId:it.id, title:it.title,
         cat:it.cat||"その他", due:due.toISOString(), doneAt:now.toISOString(), lead:Math.round(hours*10)/10,
         kind:kind, exp:exp, src:source};
  if(isRepeating(it)) c.rep=true;
  db.completions.push(c);
  trimCompletions();
  return c;
}
function applyCompletionCore(it){
  it.done=true; it.doneAt=new Date().toISOString();
  if(it.rep&&it.rep!=="none"){
    // 繰り返しはカレンダー側で先の回まで展開しているため、ここでは複製しない。
    // 「この回だけ完了」にすると次回以降が消えるので、締切日を次回へ進める。
    // 自動完了のものは、しばらく開いていなかった場合に備えて「今より先の回」まで一度に進める
    // （1回ずつだと、1分ごとの確認のたびに進んで自動同期・通知が何度も走るため）
    var now=new Date();
    var ok=advanceRepeating(it);
    while(ok && it.autoComplete && parseItemDate(it)<now) ok=advanceRepeating(it);
    if(ok){
      it.done=false; delete it.doneAt;
      return {repeating:true, next:parseItemDate(it)};
    }
    return {repeating:true, final:true};
  }
  return {repeating:false};
}

/* 繰り返しの締切を1回分進める。取りやめた回(skip)は飛ばし、回数指定があれば残り回数も減らす。
   もう次の回が無い（最終回だった）ときは何も変えずに false を返す */
function advanceRepeating(it){
  var skip=it.skip||[];
  var anchor=anchorDayOf(it);
  var due=parseItemDate(it), span=it.start?(due-new Date(it.start)):0;
  var left=it.repCount||0;
  do{
    if(left===1) return false; // 残り1回＝今の回が最終回
    if(left>1) left--;
    due=nextOccurrence(due, it.rep, anchor);
  } while(skip.indexOf(toLocalISO(due))>=0);
  // 月末(31日など)で丸めた後も元の日付に戻れるよう、基準の日を覚えておく
  if((it.rep==="monthly"||it.rep==="yearly") && !it.repDay) it.repDay=anchor;
  it.due=due.toISOString();
  if(it.start) it.start=new Date(due.getTime()-span).toISOString();
  if(it.repCount) it.repCount=left;
  it.seq=(it.seq||0)+1;
  return true;
}
/* 月・年単位の繰り返しの基準日（何日の予定か） */
function anchorDayOf(it){ return it.repDay || parseItemDate(it).getDate(); }
/* 毎月・毎年で基準日が29〜31日のとき、無い月は月末に丸める（アプリの nextOccurrence と同じ）ための RRULE の追加分。
   素の FREQ=MONTHLY は31日が無い月を飛ばすので、「基準日」と「月末」の早い方（BYSETPOS=1）を指定する。
   DTSTART は時刻つきなら UTC、終日なら日付で書くため、締切日との日数差 diff を引いて合わせる（build_ics.py と同じ計算） */
function monthEndRule(it, due, begin){
  if(it.rep!=="monthly" && it.rep!=="yearly") return "";
  var a=anchorDayOf(it);
  if(a<29) return "";
  var first;
  if(it.allDay){ var s0=it.start?new Date(it.start):due; first={y:s0.getFullYear(), m:s0.getMonth(), d:s0.getDate()}; }
  else first={y:begin.getUTCFullYear(), m:begin.getUTCMonth(), d:begin.getUTCDate()};
  var diff=Math.round((Date.UTC(due.getFullYear(),due.getMonth(),due.getDate())-Date.UTC(first.y,first.m,first.d))/86400000);
  if(diff<0 || a-diff<1 || first.m!==due.getMonth()) return ""; // 月をまたぐ期間つきなどは従来どおり
  var rule=";BYMONTHDAY="+(a-diff)+","+(-(1+diff))+";BYSETPOS=1";
  return it.rep==="yearly" ? ";BYMONTH="+(first.m+1)+rule : rule;
}

/* 次に来る回の締切。完了にし忘れて締切が過ぎている定期予定でも「今より先の回」を返す（表示用・元データは変えない）。
   回数指定を使い切っていれば null */
function upcomingDue(it){
  var c=Object.assign({},it), now=new Date(), guard=0;
  while(parseItemDate(c)<now && guard++<3000){ if(!advanceRepeating(c)) return null; }
  return parseItemDate(c);
}

function complete(it, cardEl){
  var before=totalExp();
  var wasToday=toLocalISO(parseItemDate(it))===toLocalISO(new Date());
  var r=applyCompletion(it, "manual");
  var bonus=wasToday?grantAllClearBonus():null; // 今日の締切を全部片付けたらボーナス
  var reward=rewardOf(r.log, before);
  if(bonus){ reward=rewardOf({exp:r.log.exp+bonus.exp, kind:r.log.kind}, before); reward.allClear=bonus.exp; }
  var sub;
  if(r.repeating) sub=r.final?"繰り返しの最終回をクリア":"次回は "+fmtDue(r.next,it.allDay);
  // データは先に保存する（演出中に閉じても完了は残る）。描き直しだけ演出のあとに回す
  save();
  scheduleAutoSync();
  playSfx("done");
  if(cardEl && motionOn()){
    // 今日の全クリアは、達成の帯が閉じたあと（自動でもタップでも）続けて出す
    playQuestClear(it.title, reward, sub, reward.allClear?function(){ playAllClear(reward.allClear); }:null);
    foldCard(cardEl, render);
  } else {
    toast((sub?"完了。"+sub:"完了にしました")+"（EXP +"+reward.gain+(reward.allClear?"・本日のクエスト全クリア":"")+(reward.levelUp?"・Lv."+reward.level+" に上がりました":"")+"）");
    render();
  }
}

/* 完了の演出を使うか。設定でオフ、または端末側で「視差効果を減らす」なら使わない */
function motionOn(){
  if(db.settings.motion==="off") return false;
  return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/* 効果音：Web Audio API でその場で作る（音声ファイルは使わない）。設定でオン/オフ、初期値はオフ。
   音を出す操作は、登録・完了・削除の3つ。端末の設定（演出とは別）なので同期の対象外 */
var _audioCtx=null;
function soundOn(){ return db.settings.sound==="on"; }
function audioCtx(){
  if(_audioCtx) return _audioCtx;
  var AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) return null;
  try{ _audioCtx=new AC(); }catch(e){ _audioCtx=null; }
  return _audioCtx;
}
/* ブラウザは画面の操作がないと音を出せない（特にiPhone）。最初のタップ/キー入力で用意しておく */
function unlockAudio(){
  if(!soundOn()) return;
  var ctx=audioCtx();
  if(ctx && ctx.state==="suspended") ctx.resume().catch(function(){});
}
["pointerdown","keydown","touchend"].forEach(function(ev){ document.addEventListener(ev, unlockAudio, {passive:true}); });
/* 音の並び [周波数Hz, 開始秒, 長さ秒]。やわらかい正弦波＋短いアタックと減衰で、クリック音を避ける */
var SFX={
  add:    [[660,0,.11],[880,.09,.16]],                       // 登録：軽い2音（上がる）
  done:   [[523.25,0,.12],[659.25,.09,.12],[783.99,.18,.26]], // 完了：ド・ミ・ソ（明るい）
  remove: [[440,0,.11],[329.63,.09,.2]]                       // 削除：2音（下がる）
};
function playSfx(kind){
  if(!soundOn() || !SFX[kind]) return;
  try{
    var ctx=audioCtx(); if(!ctx) return;
    if(ctx.state==="suspended") ctx.resume().catch(function(){});
    var t0=ctx.currentTime+.02;
    SFX[kind].forEach(function(n){
      var osc=ctx.createOscillator(), g=ctx.createGain(), s=t0+n[1], e=s+n[2];
      osc.type="sine"; osc.frequency.setValueAtTime(n[0], s);
      g.gain.setValueAtTime(.0001, s);
      g.gain.exponentialRampToValueAtTime(.18, s+.015);
      g.gain.exponentialRampToValueAtTime(.0001, e);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(s); osc.stop(e+.02);
    });
  }catch(e){ /* 音が出せなくても操作は止めない */ }
}

/* 経験値：期限内に早く終えるほど多い。100 EXP ごとにレベルが1上がる（この端末だけの記録） */
var EXP_PER_LEVEL=100;
function levelOf(exp){ return Math.floor((exp||0)/EXP_PER_LEVEL)+1; }
var KIND_LABEL={early:"前倒しボーナス", ontime:"期限内にクリア", late:"遅れてもクリア", auto:"自動完了"};
function rewardOf(log, before){
  var after=before+log.exp;
  return {gain:log.exp, bonus:KIND_LABEL[log.kind]||"", level:levelOf(after), levelUp:levelOf(after)>levelOf(before),
          into:after%EXP_PER_LEVEL, fromInto:before%EXP_PER_LEVEL};
}

/* ミッション達成の演出：画面中央に帯を出し、タイトル・獲得EXP・レベルを見せて自動で消える。
   タップでもすぐ閉じる。画面の操作は止めない（帯の外はそのまま触れる） */
/* ---- 今日の全クリア・レベル表示・連続日数・小さな演出 ---- */
var ALL_CLEAR_BONUS=20;
/* 今日が締切のもの（定期予定の今日の回を含む）がすべて片付いたら、1日1回だけボーナスを記録する */
function grantAllClearBonus(){
  var t=todayItems();
  if(t.due.length || t.routines.length) return null;
  var today=toLocalISO(new Date());
  if(db.completions.some(function(c){ return c.kind==="bonus" && toLocalISO(new Date(c.doneAt))===today; })) return null;
  var now=new Date();
  var c={id:"c"+now.getTime().toString(36)+Math.random().toString(36).slice(2,6), title:"本日のクエスト全クリア",
         cat:"ボーナス", due:now.toISOString(), doneAt:now.toISOString(), lead:0, kind:"bonus", exp:ALL_CLEAR_BONUS, src:"bonus"};
  db.completions.push(c); trimCompletions(); save();
  return c;
}
function playAllClear(exp){
  var old=document.querySelector(".quest"); if(old) old.remove();
  var sparks="";
  for(var k=0;k<20;k++){ var a=k/20*Math.PI*2, d=110+(k%4)*34;
    sparks+='<i style="--x:'+Math.round(Math.cos(a)*d*1.9)+'px;--y:'+Math.round(Math.sin(a)*d*.6)+'px;--d:'+(k%5)*50+'ms"></i>'; }
  var el=h('<div class="quest allclear" role="status" aria-live="polite"><div class="quest-band">'+
    '<div class="quest-sparks" aria-hidden="true">'+sparks+'</div>'+
    '<div class="quest-kicker">ALL CLEAR</div>'+
    '<div class="quest-title">本日のクエスト全クリア！</div>'+
    '<div class="quest-sub">今日が締切のものは、すべて片付きました</div>'+
    '<div class="quest-reward"><span class="quest-exp">BONUS EXP +'+exp+'</span></div>'+
    '</div></div>');
  var gone=false;
  function close(){ if(gone) return; gone=true; el.classList.add("out"); setTimeout(function(){ el.remove(); }, 260); }
  el.onclick=close; document.body.appendChild(el); setTimeout(close, 2400);
}

/* 連続日数：自分で完了にした日（自動完了・ボーナスは除く）が、今日または昨日から何日続いているか */
function streakInfo(){
  var days={};
  db.completions.forEach(function(c){ if(c.kind!=="auto" && c.kind!=="bonus") days[toLocalISO(new Date(c.doneAt))]=1; });
  var d=new Date(), todayKey=toLocalISO(d), doneToday=!!days[todayKey], n=0;
  if(!doneToday) d.setDate(d.getDate()-1);
  while(days[toLocalISO(d)]){ n++; d.setDate(d.getDate()-1); }
  return {n:n, doneToday:doneToday};
}

/* ヘッダーのレベル・EXPゲージ・連続日数。ゲージは前回表示した値から伸ばす */
var _lvShownExp=null;
function renderLevelBar(){
  var bar=document.getElementById("lvlBar"); if(!bar) return;
  var exp=totalExp(), lv=levelOf(exp), into=exp%EXP_PER_LEVEL, st=streakInfo();
  var flash=bar.querySelector(".sync-flash");
  var warn=st.n>0 && !st.doneToday && new Date().getHours()>=18; // 今日まだ完了が無く、途切れそう
  bar.innerHTML='<span class="lv-num">Lv.'+lv+'</span>'+
    '<span class="lv-gauge" title="次のレベルまで '+(EXP_PER_LEVEL-into)+' EXP"><b></b></span>'+
    '<span class="lv-exp">'+into+'/'+EXP_PER_LEVEL+'</span>'+
    (st.n?'<span class="lv-streak'+(warn?' warn':'')+'" title="'+(warn?"今日1件完了すると連続が続きます":"毎日1件以上完了した日数")+'">🔥'+st.n+'日連続'+(warn?'・今日まだ':'')+'</span>':'');
  if(flash) bar.appendChild(flash);
  var g=bar.querySelector(".lv-gauge b");
  var toPct=into/EXP_PER_LEVEL*100;
  if(_lvShownExp!==null && _lvShownExp!==exp && motionOn()){
    var fromPct=(levelOf(_lvShownExp)<lv)?0:(_lvShownExp%EXP_PER_LEVEL)/EXP_PER_LEVEL*100;
    g.style.width=fromPct+"%";
    g.offsetWidth; // 開始位置を確定させてから伸ばす
    g.classList.add("grow");
    if(levelOf(_lvShownExp)<lv) bar.querySelector(".lv-num").classList.add("up");
  }
  g.style.width=toPct+"%";
  _lvShownExp=exp;
}

/* カードを消すときの短い演出（延期は右へ流す・休みは打ち消し線・削除はしぼませる）。
   データの更新 fn() はすぐに行い（演出中に閉じても操作は残る）、
   画面に残した「写し」だけを同じ位置で動かしてから消す */
function animateCardOut(card, cls, stamp, fn){
  if(!card || !motionOn() || !card.isConnected){ fn(); return; }
  var r=card.getBoundingClientRect();
  var ghost=card.cloneNode(true);
  ghost.classList.add("ghost","leaving",cls);
  ghost.style.cssText+=";position:fixed;left:"+r.left+"px;top:"+r.top+"px;width:"+r.width+"px;height:"+r.height+"px;margin:0;z-index:40";
  ghost.querySelectorAll("button").forEach(function(b){ b.disabled=true; });
  if(stamp) ghost.appendChild(h('<span class="out-stamp" aria-hidden="true">'+stamp+'</span>'));
  fn();
  document.body.appendChild(ghost);
  setTimeout(function(){ ghost.remove(); }, cls==="deleting"?340:760);
}

function calColorMode(){ return store.get("cal-color-mode")==="status"?"status":"cat"; }

/* 開いて最初の表示だけ、サマリーの数字を 0 から数え上げる */
var _countedUp=false;
function countUpSummary(){
  if(_countedUp) return;
  var nums=document.querySelectorAll(".sum-cell .num[data-to]");
  if(!nums.length) return;
  _countedUp=true;
  if(!motionOn()) return;
  nums.forEach(function(n){
    var to=parseInt(n.getAttribute("data-to"),10)||0; if(!to) return;
    var t0=null, dur=Math.min(700, 200+to*90);
    n.textContent="0";
    function step(ts){ if(t0===null) t0=ts; var k=Math.min(1,(ts-t0)/dur);
      n.textContent=Math.round(to*(1-Math.pow(1-k,3))); if(k<1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  });
}

/* 登録の演出：「クエスト受注！」の帯を出し、今クリアした場合の報酬を見せる。
   完了の演出より短く、タップでもすぐ閉じる */
var justAddedId=null;
function playQuestAccept(it){
  var old=document.querySelector(".quest"); if(old) old.remove();
  var due=parseItemDate(it), hours=(due-new Date())/3600000;
  var exp=hours<0?5:hours<24?10:10+Math.min(40, 5*Math.floor(hours/24)); // logCompletion と同じ計算
  var left=hours<0?"期限を過ぎています":hours<24?"今日が締切":"あと"+Math.floor(hours/24)+"日";
  var el=h('<div class="quest accept" role="status" aria-live="polite">'+
    '<div class="quest-band">'+
      '<div class="quest-kicker">NEW QUEST</div>'+
      '<div class="quest-title">クエスト受注！</div>'+
      '<div class="quest-name">「'+escHtml(it.title)+'」</div>'+
      '<div class="quest-sub">期限 '+fmtDue(due,it.allDay)+'　'+left+(isRepeating(it)?'　🔁 定期クエスト':'')+'</div>'+
      '<div class="quest-reward"><span class="quest-exp">報酬 EXP +'+exp+'</span><span class="quest-bonus">'+(hours>=24?"早く片付けるほど増える":"今クリアした場合")+'</span></div>'+
    '</div></div>');
  var gone=false;
  function close(){ if(gone) return; gone=true; el.classList.add("out"); setTimeout(function(){ el.remove(); }, 260); }
  el.onclick=close;
  document.body.appendChild(el);
  setTimeout(close, 1600);
}
/* 登録したばかりのカードを一度だけ光らせ、見える位置まで寄せる */
function highlightJustAdded(){
  if(!justAddedId) return;
  var id=justAddedId; justAddedId=null;
  var card=document.querySelector('.card[data-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]');
  if(!card) return;
  if(motionOn()) card.classList.add("fresh");
  try{ card.scrollIntoView({block:"nearest", behavior:motionOn()?"smooth":"auto"}); }catch(e){}
}

function playQuestClear(title, rw, sub, onClose){
  var old=document.querySelector(".quest"); if(old) old.remove();
  var fromPct=rw.levelUp?0:rw.fromInto/EXP_PER_LEVEL*100, toPct=rw.into/EXP_PER_LEVEL*100;
  var sparks="";
  for(var k=0;k<14;k++){
    var a=k/14*Math.PI*2, d=90+(k%3)*38;
    sparks+='<i style="--x:'+Math.round(Math.cos(a)*d*1.8)+'px;--y:'+Math.round(Math.sin(a)*d*.55)+'px;--d:'+(k%4)*40+'ms"></i>';
  }
  var el=h('<div class="quest" role="status" aria-live="polite">'+
    '<div class="quest-band"><div class="quest-sparks" aria-hidden="true">'+sparks+'</div>'+
      '<div class="quest-kicker">MISSION COMPLETE</div>'+
      '<div class="quest-title">ミッション達成！</div>'+
      '<div class="quest-name">「'+escHtml(title)+'」</div>'+
      (sub?'<div class="quest-sub">'+escHtml(sub)+'</div>':'')+
      '<div class="quest-reward"><span class="quest-exp">EXP +'+rw.gain+'</span><span class="quest-bonus">'+rw.bonus+'</span></div>'+
      '<div class="quest-lv"><span>Lv.'+rw.level+'</span><span class="quest-bar"><b style="--from:'+fromPct+'%;--to:'+toPct+'%"></b></span><span>'+rw.into+'/'+EXP_PER_LEVEL+'</span></div>'+
      (rw.levelUp?'<div class="quest-up">LEVEL UP!　Lv.'+(rw.level-1)+' → Lv.'+rw.level+'</div>':'')+
    '</div></div>');
  var gone=false;
  function close(){ if(gone) return; gone=true; el.classList.add("out"); setTimeout(function(){ el.remove(); if(onClose) onClose(); }, 260); }
  el.onclick=close;
  document.body.appendChild(el);
  setTimeout(close, rw.levelUp?2600:2000);
}

/* 完了したカードを畳み、終わったら then() で描き直す。演出中はボタンを止めて二重処理を防ぐ */
function foldCard(card, then){
  if(card.classList.contains("clearing")) return;
  card.classList.add("clearing");
  card.querySelectorAll("button").forEach(function(b){ b.disabled=true; });
  var finished=false;
  function finish(){ if(finished) return; finished=true; then(); }
  setTimeout(function(){
    card.style.height=card.offsetHeight+"px";
    card.offsetHeight; // 高さを確定させてから畳む
    card.classList.add("folding");
    setTimeout(finish, 320);
  }, 700);
  setTimeout(finish, 1600); // 念のための保険（タブが裏に回ってタイマーが遅れた場合など）
}

/* 「期限を過ぎたら自動的に完了にする」を付けた締切を、実際に期限を過ぎたタイミングで
   完了処理する。起動時と定期チェックの両方から呼ぶ */
function autoCompleteOverdueItems(){
  var now=new Date();
  var affected=0;
  db.items.forEach(function(it){
    if(it.done || !it.autoComplete) return;
    if(parseItemDate(it)>=now) return; // まだ期限内
    applyCompletion(it, "auto");
    affected++;
  });
  if(affected>0){
    save();
    toast(affected===1?"期限を過ぎた締切を自動で完了にしました":"期限を過ぎた"+affected+"件を自動で完了にしました");
    scheduleAutoSync();
  }
  return affected;
}

/* 繰り返し1回分だけ日付を進める。月・年単位は基準日(anchorDay)を保ち、
   その月に無い日(31日・2/29など)は月末に丸める。
   （setMonthのままだと 1/31 の翌月が 3/3 になってしまうため） */
function nextOccurrence(d, rep, anchorDay){
  var n=new Date(d);
  if(rep==="weekly") n.setDate(d.getDate()+7);
  else if(rep==="biweekly") n.setDate(d.getDate()+14);
  else if(rep==="monthly"||rep==="yearly"){
    var y=d.getFullYear()+(rep==="yearly"?1:0), m=d.getMonth()+(rep==="monthly"?1:0);
    var last=new Date(y,m+1,0).getDate();
    n=new Date(y,m,Math.min(anchorDay||d.getDate(),last),d.getHours(),d.getMinutes(),d.getSeconds());
  }
  return n;
}

/* 表示用に、繰り返しの回を指定範囲まで展開する（保存はせず、その場で作る） */
function expandOccurrences(it, fromDate, toDate){
  var out=[];
  if(!it.rep||it.rep==="none"){ out.push(it); return out; }
  var skip=it.skip||[];  // 「この回だけ休み」にした日（YYYY-MM-DD）
  var d=parseItemDate(it), anchor=anchorDayOf(it);
  var span=it.start?(d-new Date(it.start)):0;
  var limit=(it.repCount&&it.repCount>0)?it.repCount:60; // 無期限でも60回で打ち切る
  // 無期限の繰り返しは、締切が古くても表示範囲の手前まで先に送ってから数える。
  // 数え始めを保存された締切にすると、放置された予定は60回分が過去で尽きて将来の回が出ない
  var k0=0;
  if(!(it.repCount>0)){ for(;d<fromDate && k0<5000;k0++) d=nextOccurrence(d,it.rep,anchor); }
  for(var k=k0;k<k0+limit;k++){
    if(d>toDate) break;
    if(d>=fromDate && skip.indexOf(toLocalISO(d))<0){
      var copy=Object.assign({},it);
      copy.due=d.toISOString();
      copy.isExpanded=true; // カレンダー表示用の複製であることを示す（元データではない）
      if(it.start) copy.start=new Date(d.getTime()-span).toISOString();
      if(k>0){ copy.occurrence=k; copy.done=false; } // 2回目以降は未完了として扱う
      out.push(copy);
    }
    d=nextOccurrence(d, it.rep, anchor);
  }
  return out;
}

/* 繰り返しのうち、指定日の回だけを取りやめる。
   取りやめたのが「次の回」そのものなら、締切を次の回へ進める
   （進めないと、取りやめたはずの回が一覧で締切として残り、過ぎると超過になるため） */
function skipOccurrence(id, dateKey){
  var ended=false;
  db.items.forEach(function(i){
    if(i.id!==id) return;
    if((i.skip||[]).indexOf(dateKey)<0) i.skip=(i.skip||[]).concat([dateKey]);
    if(toLocalISO(parseItemDate(i))===dateKey){
      if(!advanceRepeating(i)){ i.done=true; i.doneAt=new Date().toISOString(); ended=true; }
    } else {
      i.seq=(i.seq||0)+1;
    }
  });
  save(); render();
  toast(ended?dateKey+" の回を取りやめました（これが最終回でした）":dateKey+" の回を取りやめました");
  scheduleAutoSync();
}
/* 取りやめを元に戻す */
function unskipOccurrence(id, dateKey){
  db.items.forEach(function(i){
    if(i.id!==id) return;
    i.skip=(i.skip||[]).filter(function(x){ return x!==dateKey; });
    i.seq=(i.seq||0)+1;
  });
  save(); render();
  toast(dateKey+" の回を戻しました");
  scheduleAutoSync();
}

/* ========== テーマ・トースト ========== */
function applyTheme(){
  var t=db.settings.theme;
  if(t==="auto") t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
  document.documentElement.setAttribute("data-theme",t);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", t==="dark"?"#141311":"#F3F0E8");
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){ if(db.settings.theme==="auto"){ applyTheme(); render(); } }); // 色の表示（ダーク用の補正）を描き直す

var toastEl=document.getElementById("toast"), toastTimer=null;
var toastMsgEl=document.getElementById("toastMsg"), toastActionEl=document.getElementById("toastAction");
function toast(msg, actionLabel, actionFn){
  toastMsgEl.textContent=msg; toastEl.classList.add("on");
  if(actionLabel&&actionFn){
    toastActionEl.textContent=actionLabel;
    toastActionEl.style.display="";
    toastActionEl.onclick=function(){ actionFn(); toastEl.classList.remove("on"); clearTimeout(toastTimer); };
  } else {
    toastActionEl.style.display="none";
    toastActionEl.onclick=null;
  }
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){ toastEl.classList.remove("on"); }, actionLabel?5000:2600);
}

/* ========== リンクから直接.icsを書き出す ==========
   例: .../?export=all で開くと、未完了全件の.icsのダウンロードが始まる。
   Discordの添付を直接開くとiOSでは「照会カレンダー」になってしまうため、
   ファイルとして保存させる導線を用意する */
function handleExportParam(){
  var q=new URLSearchParams(location.search);
  var mode=q.get("export");
  if(!mode) return;
  setTimeout(function(){
    var list;
    if(mode==="rep") list=activeItems().filter(isRepeating).sort(sortByDue);
    else if(mode==="once") list=activeItems().filter(function(i){ return !isRepeating(i); }).sort(sortByDue);
    else list=activeItems().sort(sortByDue);
    if(!list.length){ toast("書き出す予定がありません"); return; }
    downloadICS(list, "deadlines");
    var guide=h('<div class="sec" style="border-color:var(--blue)">'+
      '<h3>カレンダーへの入れ方</h3>'+
      '<p>1. 保存された <b>deadlines.ics</b> を開く（Safariの右上のダウンロードマーク、または「ファイル」アプリの中）<br>'+
      '2. 「カレンダーに追加」を選ぶ<br>'+
      '3. 同じ予定は上書きされるので、何度取り込んでも重複しません</p></div>');
    main.insertBefore(guide, main.firstChild);
    window.scrollTo(0,0);
  }, 600);
  // 履歴からパラメータを消し、再読み込みで二重に書き出さないようにする
  if(history.replaceState) history.replaceState(null,"",location.pathname);
}

/* ========== リンクから直接完了にする ==========
   例: .../?done=<締切のID> で開くと、その締切の完了確認を出す。
   Discordの通知にある「✅完了」リンクの行き先。確認なしでは完了にしない。
   他の端末で更新されていないか確かめるため、GitHubの自動取り込み(pullDone)が終わるのを
   最大4秒待ってから探す（待っても終わらなければ、この端末の内容で探す） */
function handleDoneParam(pullDone){
  var q=new URLSearchParams(location.search);
  var id=q.get("done");
  if(!id) return;
  // 履歴からパラメータを消し、再読み込みで二重に完了にしないようにする
  if(history.replaceState) history.replaceState(null,"",location.pathname);
  if(id.length>80) return; // IDはもっと短い。異常な値は無視する
  var waited=Promise.race([
    Promise.resolve(pullDone).catch(function(){}),
    new Promise(function(res){ setTimeout(res, 4000); })
  ]);
  waited.then(function(){
    var it=db.items.filter(function(i){ return i.id===id; })[0];
    if(!it){ toast("その締切が見つかりません。完了済みか、まだこの端末に同期されていない可能性があります"); return; }
    if(it.done){ toast("「"+it.title+"」はすでに完了しています"); return; }
    view="list"; render(); window.scrollTo(0,0);
    // 画面を描き終えてから確認を出す（confirm中に画面が空にならないように）
    setTimeout(function(){
      var rep=isRepeating(it);
      var msg="「"+it.title+"」を完了にしますか？\n締切："+fmtDue(parseItemDate(it), it.allDay)+
              (rep?"\n（繰り返しの今回の分を完了にして、次回へ進みます）":"");
      if(confirm(msg)) complete(it, null);
    }, 150);
  });
}

/* ホーム画面ショートカットからの起動(?action=add / ?action=week)を処理する */
function handleActionParam(){
  var q=new URLSearchParams(location.search);
  var action=q.get("action");
  if(!action) return;
  if(action==="week"){
    view="week"; render();
  } else if(action==="add"){
    setTimeout(function(){ openDialog(null); }, 300);
  }
  if(history.replaceState) history.replaceState(null,"",location.pathname);
}

/* ========== オフライン対応 ==========
   一度開いておけば、電波が悪い場所でもアプリの画面自体は開けるようにする。
   データはlocalStorageにあるので、この登録自体は失敗しても致命的ではない */
if("serviceWorker" in navigator && location.protocol!=="file:"){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("./service-worker.js").catch(function(){});
  });
}

/* ========== 更新の自動反映 ==========
   GitHub Pagesは古いHTMLを長く保持することがあるため、
   起動時と復帰時にサーバー側の更新を確認し、変わっていれば読み直す */
var APP_BUILD=null;
function checkForUpdate(){
  if(location.protocol==="file:") return;
  // index.html と app.js の両方を見る（スタンプの更新を忘れて app.js だけ変えた場合も、長さの違いで気づける）
  var fresh=function(url){ return fetch(url+"?_="+Date.now(),{cache:"no-store"}).then(function(res){ return res.ok?res.text():null; }); };
  Promise.all([fresh(location.pathname), fresh(new URL("app.js",location.href).pathname)])
    .then(function(r){
      var html=r[0], js=r[1];
      if(!html || js===null) return;
      // ビルドスタンプ（無ければ内容の長さ）を版番号として使う
      var m=html.match(/<meta name="build-stamp" content="([^"]*)">/);
      var build=(m?m[1]:"")+"/"+html.length+"/"+js.length;
      if(APP_BUILD===null){ APP_BUILD=build; return; }
      if(build!==APP_BUILD){
        APP_BUILD=build;
        toast("新しい版が見つかりました。読み直します…");
        setTimeout(function(){ location.reload(); },1200);
      }
    })
    .catch(function(){});
}
document.addEventListener("visibilitychange",function(){
  if(document.hidden){ flushAutoSync(); return; } // 閉じる前に、待っている自動同期を送る
  checkForUpdate(); autoPullIfStale();
});

/* 定期的な再描画。入力欄を操作中や設定タブを開いているときは、
   打ちかけの内容(検索語・トークンなど)が消えないよう描画を見送る */
function softRender(){
  var a=document.activeElement;
  if(view==="set") return;
  if(a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  render();
}

/* ========== 起動 ========== */
document.querySelectorAll(".tab").forEach(function(t){
  t.onclick=function(){ view=t.dataset.view; window.scrollTo(0,0); render(); };
});
document.getElementById("fabAdd").onclick=function(){ openDialog(null); };
load(); autoCompleteOverdueItems(); applyTheme();
var _tabsScroller=makeHScroll(document.querySelector("nav.tabs")); // タブ列もパソコンで動かせるように
render();
handleExportParam();
handleActionParam();
setInterval(function(){ autoCompleteOverdueItems(); softRender(); }, 60000); // 残り時間の更新とあわせて自動完了も確認
checkForUpdate();
var _pullDone=autoPullIfStale();
handleDoneParam(_pullDone);
setInterval(checkForUpdate, 10*60000); // 10分ごとに更新を確認
setInterval(autoPullIfStale, 10*60000); // 10分ごとにGitHub側の新しい内容を確認
})();
