(function(){
"use strict";

/* 画面に依存しない計算は app-calc.js（index.html で先に読む）。今までどおりの名前で受け取る */
var pad=DTCalc.pad, toLocalISO=DTCalc.toLocalISO, startOfDay=DTCalc.startOfDay, daysBetween=DTCalc.daysBetween, parseItemDate=DTCalc.parseItemDate, refDate=DTCalc.refDate, isRepeating=DTCalc.isRepeating, anchorDayOf=DTCalc.anchorDayOf, nextOccurrence=DTCalc.nextOccurrence, prevOccurrence=DTCalc.prevOccurrence, advanceRepeating=DTCalc.advanceRepeating, expandOccurrences=DTCalc.expandOccurrences, monthEndRule=DTCalc.monthEndRule, toHalfWidth=DTCalc.toHalfWidth,
    WC=DTWebClass,
    ICON_PX=DTCalc.ICON_PX, isIconData=DTCalc.isIconData, cleanCatIcons=DTCalc.cleanCatIcons, iconCropRect=DTCalc.iconCropRect, encodeIcon=DTCalc.encodeIcon;

/* ========== 保存領域（localStorage が使えない環境ではメモリに退避） ========== */
var KEY="deadline-tracker-v1";
var mem={}, hasLS=false;
try{ localStorage.setItem("__t","1"); localStorage.removeItem("__t"); hasLS=true; }catch(e){ hasLS=false; }
var store={
  get:function(k){ return hasLS?localStorage.getItem(k):(k in mem?mem[k]:null); },
  set:function(k,v){ if(hasLS){try{localStorage.setItem(k,v);}catch(e){toast("保存できませんでした（空き容量を確認してください）");}} else {mem[k]=v;} }
};

/* ========== 秘密の保存（Cloudflare のアクセスキー） ==========
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
  }).catch(function(){
    // 鍵を取れなかっただけで、すでに暗号化して保存してある値まで消さない（平文で残っている値だけを消す）
    try{ var old=localStorage.getItem(name); if(old&&old.indexOf("enc1:")!==0) localStorage.removeItem(name); }catch(e){}
    return false;
  });
}
function secretDel(name){
  delete _secretCache[name];
  if(hasLS){ try{ localStorage.removeItem(name); }catch(e){} } else { delete mem[name]; }
}
/* 旧環境（GitHub 同期・Discord の直接送信）で、この端末に保存した設定を消す。
   トークンや Webhook URL を端末に残さないため。起動のたびに呼んでよい（無ければ何もしない） */
function forgetLegacySettings(){
  ["gh-token","dc-hook","gh-sync","gh-public-acked"].forEach(function(k){ secretDel(k); });
  if(db.settings && db.settings.autoNotify!==undefined){ delete db.settings.autoNotify; saveRaw(); }
}
/* 保存してある値を返す（無ければ ""）。以前の版が平文で保存した値はそのまま使い、暗号化し直す */
function secretGet(name){
  if(_secretCache[name]) return Promise.resolve(_secretCache[name]);
  var raw=store.get(name);
  if(!raw) return Promise.resolve("");
  if(raw.indexOf("enc1:")!==0){
    _secretCache[name]=raw;
    if(hasLS) secretSet(name, raw).then(function(ok){ // 暗号化できればその場で置き換える。できなければ平文は残さず消す（今回の起動中は使える）
      if(!ok) toast("この端末では暗号化して保存できないため、保存してあったアクセスキーを消しました。次回は入力し直してください");
    });
    return Promise.resolve(raw);
  }
  var parts=raw.split(":");
  return _secretKey().then(function(key){
    if(!key) return ""; // 鍵を取れなかった（一時的なエラーかもしれない）。保存してある値は消さずに、今回だけ空として扱う
    if(parts.length!==3) throw 0;
    return crypto.subtle.decrypt({name:"AES-GCM",iv:_unb64(parts[1])}, key, _unb64(parts[2])).then(function(buf){
      var v=new TextDecoder().decode(buf);
      _secretCache[name]=v;
      return v;
    });
  }).catch(function(){
    // 鍵が消えている（サイトデータの削除など）と復号できない。読めない値は残さず、入力し直してもらう
    secretDel(name);
    return "";
  });
}

var db={items:[],templates:[],trash:[],quarantine:[],completions:[],expCarry:0,categories:["仕事","提出物","課題","支払い","プライベート","その他"],catReminders:{},catColors:Object.create(null),catIcons:Object.create(null),wcExcluded:[],settings:{dayHour:9},updatedAt:null};
/* 読めなかった保存データの元の文字列。次に保存して上書きされる前に退避する（writeDb を参照） */
var _unreadableRaw=null;
function load(){
  var raw=store.get(KEY); if(!raw) return;
  try{
    var d=JSON.parse(raw);
    // ここ(自分自身のlocalStorage)は検証しない。既存の表示が急に消えて驚かせないため。
    // 壊れたデータの検証は、外部由来のCloudflareからの取り込み口(proceedPull / autoPullWith)で行う
    if(d&&Array.isArray(d.items)){
      // 型だけは、保存（Worker）の検査に通る形にそろえる（項目は消さない・隔離しない）。変えたときだけ保存し直す（updatedAt は変えない）
      var typeFixed=false;
      db.items=d.items.map(function(it){
        if(!it || typeof it!=="object" || Array.isArray(it)) return it;
        var f=normalizeItemTypes(it);
        if(JSON.stringify(f)!==JSON.stringify(it)) typeFixed=true;
        return f;
      });
    }
    // templates は後から追加した項目。古いデータには無いので空配列で補う
    if(d&&Array.isArray(d.templates)) db.templates=d.templates;
    // trash も同様に後から追加した項目
    if(d&&Array.isArray(d.trash)) db.trash=d.trash;
    if(d&&Array.isArray(d.quarantine)) db.quarantine=d.quarantine;
    if(d&&Array.isArray(d.categories)&&d.categories.length) db.categories=d.categories;
    if(d) db.catReminders=cleanCatReminders(d.catReminders);
    if(d) db.catColors=cleanCatColors(d.catColors);
    if(d) db.catIcons=cleanCatIcons(d.catIcons);
    if(d) db.wcExcluded=WC.wcCleanExcluded(d.wcExcluded);
    if(d&&d.settings) db.settings=Object.assign(db.settings,d.settings);
    if(d&&d.updatedAt) db.updatedAt=d.updatedAt;
    if(d) adoptCompletions(d);
  }catch(e){
    // 読めなかった元のデータは、次に保存して上書きされる前に退避する（writeDb を参照）
    _unreadableRaw=raw;
    toast("保存されていたデータを読めませんでした。次に保存するとき、元のデータを別の場所に残します");
  }
  // 以前この端末だけに持っていた経験値(settings.exp)は、同期される記録へ移す
  if(db.settings.exp){ db.expCarry=(db.expCarry||0)+db.settings.exp; delete db.settings.exp; }
  // ゴミ箱は、壊れた項目を除いて trashId を補い（古い形式との互換）、30日を過ぎたものと上限(30件)を超えた古いものを整理する
  db.trash=normalizeTrash(db.trash);
  var cutoff=Date.now()-30*86400000;
  db.trash=db.trash.filter(function(t){ return new Date(t.deletedAt).getTime()>=cutoff; });
  if(db.trash.length>30) db.trash=db.trash.slice(db.trash.length-30);
  if(typeFixed) writeDb(); // 型を直した項目があれば、保存し直す（updatedAt は変えない）
  // 「人の未送信の変更」の印が無い端末（この版より前）は、前回同期した時刻との比較で初期値を決める
  if(store.get("sync-dirty")===null) store.set("sync-dirty", (db.updatedAt && store.get("gh-known-updatedAt")!==db.updatedAt) ? "1" : "0");
}
/* 通常の保存（人の操作）。呼ぶたびに「この端末で今変更した」時刻を刻み、「人の未送信の変更あり」の印を立てる */
var _editSeq=0; // 人の保存の回数（送信中に新しい編集が入ったかを見分ける）
function save(){ db.updatedAt=new Date().toISOString(); _editSeq++; store.set("sync-dirty","1"); writeDb(); }
/* 機械の処理（期限切れの自動完了）の保存。同じデータ・同じ時刻からは、どの端末でも同じ結果になるので、
   「人の未送信の変更」の印は立てない（立てると、他の端末の更新の自動取り込みが止まる）。updatedAt は進める */
function saveAuto(){ db.updatedAt=new Date().toISOString(); writeDb(); }
/* 人の操作による、まだ送っていない変更があるか。印が無い（この版より前の）端末は、前回同期した時刻との比較で決める */
function hasUnsyncedChanges(){
  var d=store.get("sync-dirty");
  if(d===null) return !!(db.updatedAt && store.get("gh-known-updatedAt")!==db.updatedAt);
  return d==="1";
}
/* 送信（PUT）か取り込みが成功したときに、印を消す。mark は送る内容を作った時点の _editSeq。
   送信中に新しい人の編集が入っていたら（_editSeq が進んでいたら）消さない */
function markClean(mark){ if(mark===undefined || mark===_editSeq) store.set("sync-dirty","0"); }
/* 保存データを書く。読めなかった元のデータがあれば、上書きする前に別のキーへ退避する */
function writeDb(){
  if(_unreadableRaw!==null){
    // 前に退避したものが残っていれば上書きしない（2回目以降は別のキーに残す）
    var bk=KEY+"-unreadable";
    if(store.get(bk)!==null) bk=KEY+"-unreadable-"+Date.now();
    try{ store.set(bk, _unreadableRaw); }catch(e){}
    _unreadableRaw=null;
  }
  store.set(KEY,JSON.stringify(db));
}
/* ゴミ箱の項目を整える。元に戻せない（item が無い）項目は除き、trashId が無い古い形式には振る。
   読み込み・取り込み・同期の取り込みで使う */
function normalizeTrash(list){
  if(!Array.isArray(list)) return [];
  return list.filter(function(t){ return t && typeof t==="object" && t.item && typeof t.item==="object"; })
    .map(function(t){
      if(!t.trashId) t.trashId="tr"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
      return t;
    });
}
/* Cloudflareから受け取った内容をそのまま保存するとき用。
   updatedAtは呼び出し側でリモートの値に合わせてから使うため、ここでは上書きしない */
function saveRaw(){ writeDb(); }

/* 完了の記録（いつ・締切の何時間前に終えたか・獲得EXP）。data.json に入れて端末間で同期し、
   週次レビューでまとめる。古い記録は上限を超えたら捨て、そのEXPだけ expCarry に繰り越す */
var COMPLETION_LIMIT=500;
function cleanCompletions(arr){
  var seen={};
  return (Array.isArray(arr)?arr:[]).filter(function(c){
    if(!c || typeof c.id!=="string" || isNaN(new Date(c.doneAt).getTime())) return false;
    if(seen[c.id]) return false; // 同じ id の記録は1件だけ残す（先に出たものを残す）
    seen[c.id]=1; return true;
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

/* 項目1件の型を、保存（Worker）の検査に通る形にそろえた新しいオブジェクトを返す。隔離はしない（id・title・due は見ない）。
   取り込み（sanitizeIncomingItems）と、起動時の端末内データ（load）の両方で使う。端末内に古い型の項目が残っていると、
   Worker が全体の保存を 400 で断り、自動同期が止まるため */
function normalizeItemTypes(it){
  var fixed=Object.assign({}, it);
  if(fixed.memo!==undefined && typeof fixed.memo!=="string") delete fixed.memo; // 文字列でないメモ・カテゴリは、Worker（保存・メール・.ics）が読めないため補正する
  if(fixed.cat!==undefined && typeof fixed.cat!=="string") fixed.cat="その他";
  if(fixed.rep!==undefined && typeof fixed.rep!=="string") fixed.rep="none";
  if(fixed.rep && ["weekly","biweekly","monthly","yearly"].indexOf(fixed.rep)<0) fixed.rep="none";
  if(fixed.rep && fixed.rep!=="none" && typeof fixed.repCount!=="number") fixed.repCount=0;
  if(fixed.skip && !Array.isArray(fixed.skip)) delete fixed.skip;
  // 保存（Worker）の検査と同じ形にそろえる。1件の古い型が残ると、全体の保存が止まるため
  if(Array.isArray(fixed.skip)) fixed.skip=fixed.skip.filter(function(s){ return typeof s==="string" && /^\d{4}-\d{2}-\d{2}$/.test(s); });
  ["repCount","repDay","seq"].forEach(function(k){ if(fixed[k]!==undefined && fixed[k]!==null && !(typeof fixed[k]==="number" && isFinite(fixed[k]) && Math.floor(fixed[k])===fixed[k])) delete fixed[k]; });
  ["allDay","autoComplete","calHide"].forEach(function(k){ if(fixed[k]!==undefined && fixed[k]!==null && typeof fixed[k]!=="boolean") delete fixed[k]; });
  if(fixed.pick!==undefined && (typeof fixed.pick!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(fixed.pick))) delete fixed.pick; // 今日の一手の印は "YYYY-MM-DD" だけ
  if(typeof fixed.done!=="boolean") fixed.done=!!fixed.done;
  return fixed;
}
/* 取り込んだ項目を検証する。取り込み口(load/proceedPull/autoPullWith)でのみ使う。
   必須(id・title・有効なdue)が壊れている項目は隔離し、それ以外の軽微な不正値は
   既定値に補正して使い続けられるようにする */
function sanitizeIncomingItems(rawItems){
  var kept=[], quarantined=[];
  (rawItems||[]).forEach(function(it){
    if(!it || typeof it!=="object"){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"項目の形式が不正", raw:it}); return; }
    if(typeof it.id!=="string" || !it.id){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"idが無い、または不正", raw:it}); return; }
    if(typeof it.title!=="string" || !it.title.trim()){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"タイトルが無い、または不正", raw:it}); return; }
    var due=new Date(it.due);
    if(typeof it.due!=="string" || isNaN(due.getTime())){ quarantined.push({qid:"q"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), reason:"締切日(due)が不正な日付：「"+it.due+"」", raw:it}); return; }
    // ここから先は軽微な不正。項目ごと隔離せず、既定値に補正して使う
    var fixed=normalizeItemTypes(it);
    // Z の無い日時は、この端末では端末の時刻（JST）として読まれる。Worker も同じ時刻に読めるよう、Z の付いた形で残す
    fixed.due=due.toISOString();
    if(fixed.start){
      var s=new Date(fixed.start);
      if(typeof fixed.start!=="string" || isNaN(s.getTime())) delete fixed.start; // 開始日が壊れていれば無かったことにする
      else fixed.start=s.toISOString();
    }
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
var DOW=["日","月","火","水","木","金","土"];

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
function esc(s){ return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r\n|\r|\n/g,"\\n"); }
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
    "UID:"+esc(it.id)+"@deadline-tracker",
    "DTSTAMP:"+utc(new Date()),
    "SEQUENCE:"+(parseInt(it.seq,10)||0)];
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
/* 外から来た値（Cloudflare・JSON）を検証する。壊れた値は捨てて既定に戻す */
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
/* .ics の中身をファイルとして保存する */
function saveIcsFile(text,name){
  var blob=new Blob([text],{type:"text/calendar;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url; a.download=(name||"deadlines").replace(/[\\/:*?"<>|]/g,"_")+".ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); },1500);
  toast("カレンダーファイルを書き出しました");
}
function downloadICS(items,name){
  if(!items.length){ toast("書き出す締切がありません"); return; }
  saveIcsFile(buildICS(items),name);
}
/* Cloudflare から配信しているときは、未完了の全件の .ics を Worker に作らせる（購読用の .ics と同じ規則・同じ文面にするため。
   規則を2か所で直さずに済む）。使うのは次の全部がそろったときだけ:
     - 書き出すのが未完了の全件（list の件数が全件と同じ。絞り込んだ一部は、この端末で作る）
     - この端末に未同期の変更が無い（Worker の内容がこの端末と同じ）
     - アクセスキーがある
   キーが無い・通信できない・失敗したとき、中身が空のときは、この端末で作る（オフラインでも書き出せる） */
function icsViaWorkerOk(list){
  if(CF!==true || !list.length || list.length!==activeItems().length) return false;
  return !hasUnsyncedChanges();
}
function cfFetchIcs(cfg,dayHour){
  // 当日リマインドの時刻は端末ごとの設定で Worker は知らないので、渡す
  return fetch(cfg.api.replace(/\/data$/,"/ics")+"?dayHour="+encodeURIComponent(dayHour),{headers:cfg.headers, cache:"no-store"})
    .then(function(res){
      if(!res.ok) throw new Error("HTTP "+res.status);
      return res.text();
    });
}
function downloadIcsPreferWorker(list,name){
  var local=function(){ downloadICS(list,name); };
  return (CF===null ? cfDetect() : Promise.resolve()) // 起動直後は、配信元の判定が終わるのを待つ
    .then(function(){
      if(!icsViaWorkerOk(list)) return null;
      return getStoredCfConfig().then(function(cfg){ return cfg ? cfFetchIcs(cfg, db.settings.dayHour) : null; });
    })
    .then(function(text){
      if(text && /^BEGIN:VCALENDAR/.test(text) && text.indexOf("BEGIN:VEVENT")>=0) saveIcsFile(text,name);
      else local();
    })
    .catch(local);
}

/* ========== 状態 ========== */
var view="list", filter="ALL", calRef=new Date(), selDay=null, editingId=null, editingSeq=0, searchKw="";
var main=document.getElementById("main");

function activeItems(){ return db.items.filter(function(i){ return !i.done; }); }
/* 並び順。期間つきの予定は「開始日」を基準にして、
   カードに出ている残り日数と並びが食い違わないようにする */
function sortByDue(a,b){
  var d=refDate(a)-refDate(b);
  return d!==0?d:(parseItemDate(a)-parseItemDate(b));
}

/* ========== 今日の一手（項目17） ==========
   締切1件に任意の pick（"YYYY-MM-DD"）を持たせ、「この日に手を付ける」印にする。日付が過ぎた印は無視するだけなので、持ち越しの山はできない。
   1日 PICK_MAX 件まで。完了・延期・この回は休み・繰り返しで次の回へ進んだときは印を消す */
var PICK_MAX=3;
function picksFor(items, dateKey){
  return (items||[]).filter(function(i){ return !i.done && i.pick===dateKey; }).sort(function(a,b){ return parseItemDate(a)-parseItemDate(b); });
}
/* もう1件付けられるか。doneN は、その日にすでに済んだ一手の件数（欄の「N/3」に数える分） */
function canPick(items, dateKey, doneN){ return picksFor(items, dateKey).length+(doneN||0)<PICK_MAX; }
/* 印を付けた日付を端末内に残す（項目19。同期しない）。重ねず足し、新しい60日分だけ残す */
function addPickDay(days, dateKey, max){
  var out=(days||[]).filter(function(d){ return typeof d==="string" && d!==dateKey; });
  out.push(dateKey); out.sort();
  return out.slice(-(max||60));
}
/* 今日から数えて直近 n 日（今日を含む）のうち、印を付けた日が何日あるか */
function pickDaysIn(days, todayKey, n){
  var t=new Date(todayKey+"T00:00:00"), seen={}, c=0;
  (days||[]).forEach(function(d){
    if(seen[d]) return; seen[d]=1;
    var diff=Math.round((t-new Date(d+"T00:00:00"))/86400000);
    if(diff>=0 && diff<n) c++;
  });
  return c;
}
function tomorrowKey(){ var n=new Date(); return toLocalISO(new Date(n.getFullYear(),n.getMonth(),n.getDate()+1)); }
function pickDays(){ try{ var a=JSON.parse(store.get("pick-days")||"[]"); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
/* 済んだ一手：その日のうちは欄に残す。完了すると印は消えるので、端末内に覚えておく（同期しない） */
function pickDoneList(){
  try{ var o=JSON.parse(store.get("pick-done")||"null"); if(o && o.d===toLocalISO(new Date()) && Array.isArray(o.a)) return o.a; }catch(e){}
  return [];
}
function notePickDone(it){
  var k=toLocalISO(new Date());
  if(it.pick!==k) return;
  var a=pickDoneList().filter(function(x){ return x.id!==it.id; });
  a.push({id:it.id, t:it.title, w:fmtDue(parseItemDate(it), it.allDay)});
  store.set("pick-done", JSON.stringify({d:k, a:a}));
}
function unnotePickDone(id){
  var a=pickDoneList(); if(!a.length) return;
  store.set("pick-done", JSON.stringify({d:toLocalISO(new Date()), a:a.filter(function(x){ return x.id!==id; })}));
}
function setPick(id, dateKey){
  var it=db.items.find(function(x){ return x.id===id; });
  if(!it || it.done){ render(); return; }
  var tk=toLocalISO(new Date());
  if(it.pick!==dateKey && !canPick(db.items, dateKey, dateKey===tk?pickDoneList().length:0)){ toast("一手は1日"+PICK_MAX+"件までです"); return; }
  it.pick=dateKey;
  store.set("pick-days", JSON.stringify(addPickDay(pickDays(), dateKey, 60)));
  save(); render(); scheduleAutoSync();
  if(techoStyle()) playSfx("tick"); // 手帳風：印を付ける「シュッ」
  toast("「"+it.title+"」を"+(dateKey===tk?"今日":"明日")+"の一手にしました");
}
function clearPick(id){
  var it=db.items.find(function(x){ return x.id===id; });
  if(!it || !it.pick) return;
  delete it.pick; save(); render(); scheduleAutoSync();
}

/* ========== メモ内チェックリスト（項目18） ==========
   メモの「- [ ] 手順」「- [x] 手順」の行を、カードの上でチェックできるようにする。データの形（メモは文字列）は変えない。
   押すとメモの `[ ]` と `[x]` だけを入れ替える（他の行・空白・改行コードは1文字も変えない） */
var CHECK_RE=/^([ \t]*[-*][ \t]\[)( |x|X)(\][ \t]+)(.*?)(\r?)$/;
/* メモを行ごとに分ける。チェックの行は {line, check:true, checked, text}、ふつうの行は {line, check:false, text}。メモが文字列でなければ空 */
function parseChecklist(memo){
  if(typeof memo!=="string" || !memo) return [];
  return memo.split("\n").map(function(raw, line){
    var m=CHECK_RE.exec(raw);
    return m ? {line:line, check:true, checked:m[2]!==" ", text:m[4]} : {line:line, check:false, text:raw.replace(/\r$/,"")};
  });
}
/* line 行目のチェックを入れ替えた新しい文字列。その行がチェックの行でなければメモをそのまま返す */
function toggleChecklist(memo, line){
  if(typeof memo!=="string") return memo;
  var lines=memo.split("\n"), m=lines[line]!==undefined ? CHECK_RE.exec(lines[line]) : null;
  if(!m) return memo;
  lines[line]=m[1]+(m[2]===" "?"x":" ")+m[3]+m[4]+m[5];
  return lines.join("\n");
}
/* 進み具合 {done, total}。チェックの行が無ければ null */
function checklistProgress(memo){
  var rows=parseChecklist(memo).filter(function(r){ return r.check; });
  if(!rows.length) return null;
  return {done:rows.filter(function(r){ return r.checked; }).length, total:rows.length};
}
var CHECK_SHOW=5; // これより多いチェックの行は畳んで「ほか N 件」にする

function h(html){ var t=document.createElement("template"); t.innerHTML=html.trim(); var el=t.content.firstElementChild; applyDyn(el); return el; }
/* 計算で決まる見た目（色・幅・位置）は、style 属性では書かず data-st="プロパティ:値;…" で渡し、要素ができてから CSSOM で付ける。
   CSP で style 属性を許さない（style-src-attr 'none'）ため。固定の見た目は styles.css のクラスに置く */
function applyDyn(root){
  if(!root || !root.querySelectorAll) return root;
  var list=Array.prototype.slice.call(root.querySelectorAll("[data-st]"));
  if(root.hasAttribute("data-st")) list.push(root);
  list.forEach(function(el){
    el.getAttribute("data-st").split(";").forEach(function(d){
      var i=d.indexOf(":"); if(i<0) return;
      el.style.setProperty(d.slice(0,i).trim(), d.slice(i+1).trim());
    });
    el.removeAttribute("data-st");
  });
  return root;
}
function escHtml(s){ return String(s).replace(/[&<>"]/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

/* ヘッダー右上の数字・ラベル・補足。
   「7日以内」は締切のみを数える（定期予定は常時あるため除く）。数えない定期予定は、補足に「＋定期 N」と添えて、
   すぐ下の一覧の「今週」に並ぶカードと食い違って見えないようにする。
   期限切れには、完了にし忘れた定期予定も含める（自動完了のものは期限を過ぎると次回へ進むので入らない） */
function headerCount(active, now, view){
  var within7=function(i){ return parseItemDate(i)>=now && daysBetween(now,refDate(i))<=7; };
  var over=active.filter(function(i){ return parseItemDate(i)<now; });
  if(view==="rep") return {num:active.filter(isRepeating).length, label:"定期予定", sub:""};
  if(view==="over") return {num:over.length, label:"超過", sub:""};
  if(over.length) return {num:over.length, label:"期限切れ", sub:""};
  var reps=active.filter(function(i){ return isRepeating(i) && within7(i); }).length;
  return {num:active.filter(function(i){ return !isRepeating(i) && within7(i); }).length, label:"締切 7日以内", sub:reps?"＋定期 "+reps:""};
}

/* ========== 描画 ========== */
var _lastTabView=null, _lastPageView=null;
function render(){
  resetColorCache();
  var now=new Date();
  document.getElementById("todayLabel").textContent =
    now.getFullYear()+"年"+(now.getMonth()+1)+"月"+now.getDate()+"日（"+DOW[now.getDay()]+"）";
  var over=activeItems().filter(function(i){ return parseItemDate(i)<now; });
  var hc=headerCount(activeItems(), now, view);
  document.getElementById("cntNum").textContent=hc.num;
  document.getElementById("cntLabel").textContent=hc.label;
  document.getElementById("cntSub").textContent=hc.sub;
  document.body.setAttribute("data-view", view);
  document.body.setAttribute("data-cols", db.settings.cols==="1"?"1":"2"); // 広い画面のカードの並び（styles.css の 960px 以上で効く）
  renderLevelBar();
  document.documentElement.classList.toggle("no-motion", !motionOn());
  document.documentElement.classList.toggle("techo", techoStyle());
  setTimeout(countUpSummary, 0);

  // 日表示は今週タブ、超過・定期予定は一覧タブの一部として扱う（設定はメニュー（☰）なので、どのタブも選ばない）
  var tabView=(view==="day")?"week":(view==="over"||view==="rep")?"list":view;
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
  // 期限切れの件数は一覧タブに出し、ほかの画面にいても気づけるようにする
  var overBadge=document.querySelector('.tab[data-view="list"] .tab-badge');
  if(overBadge){
    overBadge.hidden=!over.length;
    overBadge.textContent=over.length||"";
    overBadge.setAttribute("aria-label","期限切れ "+over.length+" 件");
  }
  var gear=document.getElementById("gearBtn");
  if(gear) gear.setAttribute("aria-pressed", view==="set"?"true":"false");
  document.getElementById("fabAdd").style.display = (view==="set")?"none":"";

  main.innerHTML="";
  if(!hasLS) main.appendChild(h('<div class="notice">この画面ではブラウザの保存領域が使えないため、入力内容は再読み込みで消えます。プライベートブラウズを使っているときは、通常のウィンドウで開いてください。</div>'));
  if(view==="list") renderList();
  else if(view==="week") renderWeek();
  else if(view==="day") renderDay();
  else if(view==="over") renderOverdue();
  else if(view==="rep") renderRepeat();
  else if(view==="cal") renderCal();
  else if(view==="done") renderDone();
  else renderSettings();
  // 画面を切り替えたときだけ演出と音を出す（同じ画面の再描画・同期・起動直後の描画では出さない）
  if(_lastPageView!==null && view!==_lastPageView) pageTransition();
  _lastPageView=view;
}

/* カテゴリの絞り込み。数が多くて画面に収まらないときは横に動かせる（スワイプ・ホイール・ドラッグ・‹ ›）。
   描き直しても前の位置を保ち、選んでいるカテゴリが見える位置に寄せる */
var _filterScrollLeft=0;
function filterBar(){
  var bar=h('<div class="filters"></div>');
  var cats=["ALL"].concat(db.categories);
  cats.forEach(function(c){
    var b=h('<button class="chip">'+(c==="ALL"?"":swatch(catColor(c))+catIcon(c))+escHtml(c==="ALL"?"すべて":c)+'</button>');
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
/* カテゴリーのアイコン（未設定なら何も出さない）。値は isIconData を通ったものだけなので、属性にそのまま入れてよい */
function catIcon(cat){
  var v=db.catIcons[cat||"その他"];
  return (v && isIconData(v)) ? '<img class="cat-ico" src="'+v+'" alt="" aria-hidden="true">' : '';
}
/* 設定のカテゴリ行に出す、アイコンの欄。未設定なら「画像を選ぶ」、設定済みならサムネイルと「変える」「消す」 */
var ICON_FILE_MAX=10*1024*1024;
var ICON_TYPES=["image/png","image/jpeg","image/webp","image/gif"];
function catIconRow(c){
  var has=!!db.catIcons[c];
  var el=h('<div class="ico-row">アイコン：'+(has?catIcon(c):'')+'<input type="file" accept="'+ICON_TYPES.join(",")+'" hidden></div>');
  var input=el.querySelector("input");
  var pick=h('<button type="button" class="act">'+(has?"変える":"画像を選ぶ")+'</button>');
  pick.setAttribute("aria-label","「"+c+"」のアイコンの"+(has?"画像を変える":"画像を選ぶ"));
  pick.onclick=function(){ input.click(); };
  el.appendChild(pick);
  if(has){
    var del=h('<button type="button" class="act">消す</button>');
    del.setAttribute("aria-label","「"+c+"」のアイコンを消す");
    del.onclick=function(){ delete db.catIcons[c]; save(); scheduleAutoSync(); render(); toast("「"+c+"」のアイコンを消しました"); };
    el.appendChild(del);
  }
  input.onchange=function(){
    var f=input.files && input.files[0]; input.value="";
    if(!f) return;
    makeCatIcon(f).then(function(data){
      db.catIcons[c]=data; save(); scheduleAutoSync(); render();
      toast("「"+c+"」のアイコンを設定しました");
    }, function(e){ toast(e && e.message ? e.message : "この画像は使えませんでした"); });
  };
  return el;
}
/* 選んだ画像を、端末の中で 64×64px に中央で切り抜いて縮小し、data URL にする（描き直すので、写真の位置情報は残らない） */
function makeCatIcon(file){
  if(ICON_TYPES.indexOf(file.type)<0) return Promise.reject(new Error("PNG・JPEG・WebP・GIF の画像を選んでください"));
  if(file.size>ICON_FILE_MAX) return Promise.reject(new Error("画像が大きすぎます（10MB まで）"));
  return new Promise(function(resolve,reject){
    var url=URL.createObjectURL(file), img=new Image();
    img.onload=function(){
      try{
        var r=iconCropRect(img.naturalWidth,img.naturalHeight);
        if(!r.side) throw new Error("この画像は読み取れませんでした");
        var cv=document.createElement("canvas"); cv.width=ICON_PX; cv.height=ICON_PX;
        cv.getContext("2d").drawImage(img,r.sx,r.sy,r.side,r.side,0,0,ICON_PX,ICON_PX);
        var data=encodeIcon(function(type,q){ return cv.toDataURL(type,q); });
        if(!data) throw new Error("この画像は、小さくしても上限（約8KB）に収まりませんでした");
        resolve(data);
      }catch(e){ reject(e); }
      finally{ URL.revokeObjectURL(url); }
    };
    img.onerror=function(){ URL.revokeObjectURL(url); reject(new Error("この画像は読み取れませんでした")); };
    img.src=url;
  });
}
function swatch(color, title){ return '<i class="sw" data-st="background:'+color+'"'+(title?' title="'+escHtml(title)+'"':'')+' aria-hidden="true"></i>'; }

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
    cur.innerHTML=swatch(displayColor(raw))+'<span>'+(value?escHtml(value):escHtml(opts.autoText||"自動"))+'</span>'; applyDyn(cur);
    hexIn.value=value||""; nat.value=(value||raw).toLowerCase();
    grid.querySelectorAll("button").forEach(function(b){ b.setAttribute("aria-pressed", b.getAttribute("data-c")===value?"true":"false"); });
  }
  CAT_PALETTE.forEach(function(c,i){
    var b=h('<button type="button" class="cp-sw" data-c="'+c+'" title="'+CAT_HUES[i%12]+"（"+["濃","中","淡"][Math.floor(i/12)]+"） "+c+'" data-st="background:'+displayColor(c)+'"></button>');
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
  // 日本語変換を確定する Enter は除く（Safari は isComposing が false で keyCode 229 のまま届くことがある）
  hexIn.onkeydown=function(e){ if(e.key==="Enter" && !e.isComposing && e.keyCode!==229){ e.preventDefault(); el.querySelector(".cp-apply").click(); } };
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
/* カードの下の線（経過メーター）の長さ（0〜100）。
   繰り返さない予定：登録した日から締切まで（登録日が無ければ、締切の14日前に登録したとみなす）。
   繰り返す予定：前の回から次の回まで（毎週なら7日の中での位置）。初回の登録日から測ると、毎回ほぼいっぱいになるため */
function progressOf(it, now){
  if(it.done) return 100;
  var d=parseItemDate(it), from;
  if(isRepeating(it)) from=prevOccurrence(d, it.rep, anchorDayOf(it));
  else from=it.created?new Date(it.created):new Date(d.getTime()-14*86400000);
  var total=Math.max(1, d-from), pass=Math.min(total, Math.max(0, now-from));
  return Math.round(pass/total*100);
}
function cardOf(it){
  var cs=cardStateOf(it), st=cs.cls, r=remainText(it), d=parseItemDate(it);
  var pct=progressOf(it, new Date());
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
      // 1行目は「いつ」（状態の判子と日時）、2行目は属性。日時がどのカードでも同じ位置に来る
      '<div class="meta meta-when">'+(badge?'<span class="badge '+badge[2]+'"><i aria-hidden="true">'+badge[0]+'</i>'+badge[1]+'</span>':'')+
      (!isCopy&&!it.done&&it.pick===toLocalISO(new Date())?'<span class="badge pk"><i aria-hidden="true">◎</i>一手</span>':'')+
      (!isCopy&&!it.done&&it.pick===tomorrowKey()?'<span class="badge pk"><i aria-hidden="true">◎</i>明日の一手</span>':'')+
      '<span class="num">'+
      escHtml(it.start?(fmtDue(new Date(it.start),it.allDay)+" 〜 "+fmtDue(d,it.allDay)):fmtDue(d,it.allDay))+'</span></div>'+
      '<div class="meta meta-attr">'+(isRepeating(it)&&!it.done?'<span class="badge rt"><i aria-hidden="true">↻</i>定期</span>':'')+
      '<span class="cat catg">'+swatch(itemColor(it))+catIcon(it.cat)+escHtml(it.cat||"その他")+'</span>'+
      (checklistProgress(it.memo)?'<span class="chk-prog num"></span>':"")+
      (it.allDay?'<span class="cat">終日</span>':"")+
      (it.autoComplete?'<span class="cat">自動完了</span>':"")+
      (isRepeating(it)&&it.calHide?'<span class="cat">カレンダー非表示</span>':"")+
      (it.rep&&it.rep!=="none"?'<span class="cat">'+({weekly:"毎週",biweekly:"隔週",monthly:"毎月",yearly:"毎年"}[it.rep])+
        (it.repCount>0?" 残"+it.repCount+"回":"")+'</span>':"")+'</div>'+
      (checklistProgress(it.memo)?memoChecklistHtml(it.memo, it.done||isCopy):(it.memo?'<p class="memo">'+escHtml(it.memo)+'</p>':""))+
      (isStale(it)&&!it.done?'<p class="stale-note">⚠️ '+overdueDays(it)+'日が過ぎています。まだ必要ですか？完了か削除をおすすめします。</p>':"")+
      '<div class="rail"><i data-st="width:'+pct+'%"></i></div>'+
      '<div class="acts"></div>'+
    '</div></article>');
  wireChecklist(el, it);
  var acts=el.querySelector(".acts");
  function add(label,cls,fn){ var b=h('<button class="act '+(cls||"")+'">'+label+'</button>'); if(label==="完了にする"||label==="削除"||(techoStyle() && ["今日の一手にする","明日の一手にする","明日に延期","この回は休み"].indexOf(label)>=0)) b.setAttribute("data-sfx","own"); /* 専用の音がある（共通の音は鳴らさない） */ b.onclick=fn; acts.appendChild(b); }
  if(!it.done){
    if(isCopy){
      // 2回目以降の表示専用コピー：この回の取りやめと、.ics書き出しのみ許可
      var key=toLocalISO(parseItemDate(it));
      add("この回は休み","",function(){
        if(confirm(key+" の回だけ取りやめます。よろしいですか？")) animateCardOut(el, "skipping", "休み", function(){ skipOccurrence(it.id, key); });
      });
      add("カレンダーへ","primary",function(){ downloadICS([it], it.title); });
      var note=h('<div class="note mt-6">完了・編集は「定期予定」の一覧（一覧の下のリンク）から行ってください</div>');
      el.querySelector(".body").appendChild(note);
    } else {
      add("完了にする","main",function(){ complete(it, el); });
      var tkP=toLocalISO(new Date()), tmP=tomorrowKey();
      if(it.pick===tkP||it.pick===tmP) add("一手から外す","",function(){ clearPick(it.id); });
      if(it.pick!==tkP) add("今日の一手にする","",function(){ setPick(it.id, tkP); });
      if(it.pick!==tmP) add("明日の一手にする","",function(){ setPick(it.id, tmP); });
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
      it.done=false; delete it.doneAt; delete it.doneLog; it.seq=(it.seq||0)+1; unnotePickDone(it.id); save(); render(); scheduleAutoSync();
    });
  }
  add("削除","danger",function(){ if(confirm("「"+it.title+"」を削除します。よろしいですか？")){ animateCardOut(el, "deleting", "", function(){ deleteItem(it); }); } });
  var mainAct=acts.querySelector(".act.main");
  if(mainAct){
    var more=h('<div class="more" hidden></div>');
    Array.prototype.slice.call(acts.children).forEach(function(b){ if(b!==mainAct) more.appendChild(b); });
    var tg=h('<button type="button" class="act more-btn" aria-expanded="false" aria-label="ほかの操作" title="ほかの操作">…</button>');
    tg.onclick=function(){ more.hidden=!more.hidden; tg.setAttribute("aria-expanded", more.hidden?"false":"true"); };
    acts.appendChild(tg);
    acts.parentNode.appendChild(more);
  }
  return el;
}

/* チェックの行を持つメモの HTML。ふつうの行はそのまま、チェックの行は押せる行（label）にする。
   完了済みのカードと繰り返しの複製は押せない（disabled）。チェックの行が CHECK_SHOW を超えたら、残りは畳んで「ほか N 件」にする */
function memoChecklistHtml(memo, locked){
  var rows=parseChecklist(memo), n=0, out='<div class="memo memo-list'+(locked?' locked':'')+'">', more='', hidden=0;
  var total=rows.filter(function(r){ return r.check; }).length, fold=total>CHECK_SHOW; // 畳むのは、チェックの行が上限より多いときだけ
  rows.forEach(function(r){
    var html;
    if(r.check){
      n++;
      html='<label class="chk-row"><input type="checkbox" class="chk-in" data-line="'+r.line+'"'+(r.checked?' checked':'')+(locked?' disabled':'')+'>'+
        '<span class="chk-box" aria-hidden="true"></span><span class="chk-text">'+escHtml(r.text)+'</span></label>';
    } else {
      html='<div class="memo-line">'+escHtml(r.text)+'</div>';
    }
    if(fold && (n>CHECK_SHOW || (n===CHECK_SHOW && !r.check))){ more+=html; if(r.check) hidden++; } else out+=html;
  });
  if(hidden) out+='<button type="button" class="memo-more">ほか '+hidden+' 件</button><div class="memo-rest" hidden>'+more+'</div>';
  return out+'</div>';
}
/* カードのチェック欄を動くようにし、進み具合（☑ 3/7）を出す。押したらメモを書き換えて保存・同期する（描き直しはせず、その場で表示を直す） */
function wireChecklist(el, it){
  var prog=el.querySelector(".chk-prog");
  if(!prog) return;
  function showProgress(memo){
    var p=checklistProgress(memo); if(!p) return;
    var all=p.done===p.total;
    prog.className="chk-prog num"+(all?" all":"");
    prog.textContent="☑ "+p.done+"/"+p.total+(all?" 済":"");
  }
  showProgress(it.memo);
  var more=el.querySelector(".memo-more");
  if(more) more.onclick=function(){ el.querySelector(".memo-rest").hidden=false; more.hidden=true; };
  Array.prototype.forEach.call(el.querySelectorAll("input.chk-in"), function(cb){
    if(techoStyle()) cb.setAttribute("data-sfx","own"); // 手帳風は専用の音（シュッ）。共通の音を重ねない
    cb.onchange=function(){
      // 同期で一覧が差し替わっていると、渡された項目は古いことがある。いまの項目のメモを書き換える
      var cur=db.items.find(function(x){ return x.id===it.id; });
      var line=parseInt(cb.getAttribute("data-line"),10);
      var next=cur?toggleChecklist(cur.memo, line):null;
      if(!cur || next===cur.memo){ cb.checked=!cb.checked; render(); return; }
      cur.memo=next; save(); scheduleAutoSync();
      if(techoStyle()) playSfx("tick"); // 手帳風：赤ペンでレ点を入れる「シュッ」
      showProgress(next);
    };
  });
}

/* 締切を登録・編集したとき、設定が揃っていれば自動で同期する。
   同期先やトークンが未設定なら何もしない（初回利用者の邪魔をしない） */
function autoSyncIfConfigured(){
  clearTimeout(_autoSyncTimer); _autoSyncTimer=null;
  if(!db.settings.autoSync) return;
  getStoredSyncConfig().then(function(cfg){ if(cfg) runAutoSync(cfg); }).catch(function(){}); // 自動処理なので、失敗は runAutoSync の中で扱う
}

function runAutoSync(cfg){
  if(cfAutoBlocked(cfg)) return;
  var pushedAt=db.updatedAt; // 送信中に別の編集が入っても、送った時点の値を記録するため捕捉しておく
  var mark=_editSeq;         // 送る内容を作った時点の、人の編集の回数
  var payload=syncPayload();
  // 手元の rev を If-Match に付けて直接送る（衝突は Worker が 409 で断る）。先に全データを読み直さない
  cfPut(cfg,payload)
    .then(function(res){
      if(res && res.status===409){
        // 新しい版で自動的に送り直すと、他の端末の更新を消してしまう。止めて知らせる
        if(!_autoSyncBlockedShown){
          _autoSyncBlockedShown=true;
          toast("Cloudflareに他の端末の更新があるため、自動同期を止めました。設定（右上のメニュー（☰））で読み込むか同期するかを選んでください");
        }
        return null;
      }
      return res;
    })
    .then(function(res){
      if(res && (res.status===401 || res.status===429)) cfNoteAuthFailure({status:res.status});
      if(res && res.ok){
        markSynced("自動同期");
        markPulled(); // 送った内容＝この端末の最新状態としてよい
        store.set("gh-known-updatedAt", pushedAt); // 保存先ともこの時点で一致した
        markClean(mark);
        _autoSyncBlockedShown=false;
        _autoSyncFailShown=""; _lastAutoSyncError=null;
        toast("Cloudflareに自動同期しました");
      } else if(res && res.status!==409 && res.status!==401 && res.status!==429){
        return noteAutoSyncFailure(res); // 400・413・5xx など。黙って止まらず、理由を知らせる
      }
    })
    .catch(function(e){ cfNoteAuthFailure(e); /* 自動処理なので、ほかの失敗は通知しない */ });
}
/* 自動同期が 400・413・5xx などで断られたとき、Worker が返す理由を1回だけトーストで出し、設定の同期の節にも残す。
   同じ理由の失敗が続く間は、トーストを繰り返さない（成功したら記録を消す） */
var _autoSyncFailShown="", _lastAutoSyncError=null;
function noteAutoSyncFailure(res){
  return res.json().catch(function(){ return {}; }).then(function(j){
    var reason=String((j&&(j.error||j.message))||("HTTP "+res.status)).slice(0,150);
    _lastAutoSyncError={reason:reason, at:Date.now()};
    if(_autoSyncFailShown!==reason){
      _autoSyncFailShown=reason;
      toast("自動同期に失敗しました："+reason+"。設定（右上のメニュー（☰））の同期から送り直せます");
    }
  });
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

/* 保存先へ送る内容。設定(テーマ等)とこの端末専用の隔離データは含めない */
function syncPayload(){
  return {items:db.items, templates:db.templates, trash:db.trash, categories:db.categories, catReminders:db.catReminders, catColors:db.catColors, catIcons:db.catIcons, wcExcluded:db.wcExcluded,
          completions:db.completions, expCarry:db.expCarry||0, updatedAt:db.updatedAt};
}

/* Cloudflare 上に、この端末が前回の同期・読み込み以降に知らない更新があるか */
function remoteHasUnknownChanges(r){
  if(!r.sha) return false;              // まだデータが無い
  return cfKnownRev()!==r.sha;          // 版（rev）で比べる。一度も読み込み・同期していない端末は、既存の内容を知らない
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
  var warn=document.querySelector(".sync-warn"); if(warn) warn.remove(); // 設定画面の「未入力」「停止中」の案内は、同期できたら消す
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
/* この端末が Cloudflare 上のデータを最後に取得した時刻。
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
  playSfx(techoStyle()?"crumple":"remove"); // 手帳風：紙を丸める「くしゃっ」
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
  // 同期で一覧が差し替わっていると、渡された項目は古いことがある。いまの項目で延期する
  it=db.items.find(function(x){ return x.id===it.id; });
  if(!it){ render(); return; }
  var due=parseItemDate(it), t=new Date();
  var nd=new Date(t.getFullYear(),t.getMonth(),t.getDate()+1,due.getHours(),due.getMinutes());
  var before={due:it.due, start:it.start, pick:it.pick};
  var shift=nd-due;
  delete it.pick; // 今日の一手の印は、延期したら外す
  it.due=nd.toISOString();
  if(it.start) it.start=new Date(new Date(it.start).getTime()+shift).toISOString();
  it.seq=(it.seq||0)+1;
  save(); render();
  if(techoStyle()) playSfx("pita"); // 手帳風：付箋を貼り直す控えめな「ぴたっ」
  toast("締切を "+fmtDue(nd,it.allDay)+" に延期しました", "元に戻す", function(){
    it.due=before.due;
    if(before.start) it.start=before.start; else delete it.start;
    if(before.pick) it.pick=before.pick;
    it.seq=(it.seq||0)+1;
    save(); render(); scheduleAutoSync();
  });
  scheduleAutoSync();
}
/* ゴミ箱から個別に復元する。同じidが既に一覧にある場合(自動pull等で復活済み)は
   上書きせず、その旨を知らせるだけにする */
function restoreFromTrash(trashId){
  if(!trashId) return; // id の無い項目をまとめて触らないよう、何もしない
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
  if(techoStyle()) playSfx("unfold"); // 手帳風：紙を広げる「かさっ」
  toast("「"+entry.item.title+"」を元に戻しました");
  scheduleAutoSync();
}
function purgeTrashItem(trashId){
  if(!trashId) return; // id の無い項目をまとめて消さないよう、何もしない
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


/* タイトル・メモの部分一致で絞り込む検索欄 */
var searchOpen=false;
function searchBar(){
  var bar=h('<div class="search-row"><input type="text" id="searchBox" placeholder="タイトル・メモで検索" aria-label="タイトル・メモで検索"><button type="button" class="btn">閉じる</button></div>');
  var input=bar.querySelector("input");
  input.value=searchKw;
  input.oninput=function(){
    searchKw=input.value;
    renderListBody(); // 欄自体は再描画せず、結果だけ差し替えてIME入力中の欠落を防ぐ
  };
  bar.querySelector("button").onclick=function(){ searchOpen=false; searchKw=""; render(); };
  return bar;
}
/* 一覧の絞り込みの列：カテゴリの右に「↻ 定期」（定期予定も出すか）と虫めがね（検索欄を開く）を置く */
function listFilterRow(){
  var showRoutine=store.get("list-show-routine")!=="0";
  var row=h('<div class="fbar"></div>');
  row.appendChild(filterBar());
  var tools=h('<div class="ftools">'+
    '<button type="button" class="chip rt-chip" aria-pressed="'+showRoutine+'" title="定期予定も一覧に出す"><i aria-hidden="true">↻</i>定期</button>'+
    '<button type="button" class="chip icon-chip" aria-label="タイトル・メモで検索" aria-expanded="'+searchOpen+'">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg></button></div>');
  tools.children[0].onclick=function(){ store.set("list-show-routine", showRoutine?"0":"1"); render(); };
  tools.children[1].onclick=function(){
    searchOpen=!searchOpen;
    if(!searchOpen) searchKw="";
    render();
    var box=document.getElementById("searchBox"); if(box) box.focus();
  };
  row.appendChild(tools);
  return row;
}
function matchesSearch(it){
  if(!searchKw.trim()) return true;
  var kw=searchKw.trim().toLowerCase();
  return (it.title||"").toLowerCase().indexOf(kw)>=0 || (it.memo||"").toLowerCase().indexOf(kw)>=0;
}

function renderList(){
  if(needsKeyCard(CF, !!store.get("cf-key"), _cfAuthStopped, _cfKeyOk)) main.appendChild(keyCard());
  main.appendChild(quickBar());
  main.appendChild(picksSection());
  main.appendChild(todaySummary());
  main.appendChild(listFilterRow());
  if(searchOpen||searchKw.trim()) main.appendChild(searchBar());
  var body=h('<div id="listBody"></div>');
  main.appendChild(body);
  renderListBody();
}

/* ========== 自然文クイック入力（案C） ==========
   「明日 17時 レポート提出」のような1行から日時・繰り返し・カテゴリ・テンプレートを読み取り、
   登録ダイアログに下書きとして入れて開く。読み取れなかった部分はダイアログで直してもらう */
var quickText="", quickHelpOpen=false, fromQuick=false;
var QUICK_DOW={"日":0,"月":1,"火":2,"水":3,"木":4,"金":5,"土":6};
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
  if(r.cat) parts.push(catIcon(r.cat)+"#"+escHtml(r.cat));
  if(r.tpl) parts.push("テンプレート「"+escHtml(r.tpl.name)+"」");
  parts.push(r.title?"「"+escHtml(r.title)+"」":'<span class="c-amber">タイトル未入力</span>');
  if(!r.date) parts.push('<span class="c-ink3">日付は読み取れませんでした（今日で開きます）</span>');
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
      prev.innerHTML='<a href="#" class="c-ink3">'+(quickHelpOpen?"書き方を閉じる":"書き方の例")+'</a>';
      prev.querySelector("a").onclick=function(e){ e.preventDefault(); quickHelpOpen=!quickHelpOpen; render(); };
      return;
    }
    prev.innerHTML=describeQuick(parseQuick(quickText));
  }
  input.oninput=update;
  function go(){ if(!input.value.trim()){ input.focus(); return; } openQuickDialog(parseQuick(input.value)); }
  // 日本語変換を確定する Enter は除く（Safari は isComposing が false で keyCode 229 のまま届くことがある）
  input.onkeydown=function(e){ if(e.key==="Enter" && !e.isComposing && e.keyCode!==229){ e.preventDefault(); go(); } };
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

/* 一覧の最上段の「今日の一手」の欄（手帳の「本日の要件」欄）。罫線3行。
   印の付いた締切（締切の早い順）と、今日済んだ一手（打ち消し線と「済」）を入れる。
   今日も明日も印が無いときは、見出しと案内の1行に縮める */
function picksSection(){
  var tk=toLocalISO(new Date());
  var list=picksFor(db.items, tk), done=pickDoneList(), tm=picksFor(db.items, tomorrowKey()).length;
  var n=list.length+done.length;
  var slim=!n && !tm;
  var el=h('<section class="picks'+(slim?" slim":"")+'" aria-label="今日の一手"><div class="pk-head"><b>今日の一手</b>'+
    '<span class="num pk-n">'+n+'/'+PICK_MAX+'</span>'+
    (slim?'<span class="pk-hint">カードの「…」から一手を選ぶ</span>':'')+'</div></section>');
  if(slim) return el;
  var ol=h('<ol class="pk-list"></ol>');
  list.forEach(function(i){
    var li=h('<li class="pk-row"><button type="button" class="pk-go"><span class="pk-mark" aria-hidden="true">◎</span>'+
      '<span class="pk-title">'+escHtml(i.title)+'</span><span class="pk-when num">'+escHtml(fmtDue(parseItemDate(i), i.allDay))+'</span></button></li>');
    li.querySelector("button").onclick=function(){ goToCard(i.id); };
    ol.appendChild(li);
  });
  done.forEach(function(x){
    ol.appendChild(h('<li class="pk-row done"><span class="pk-mark" aria-hidden="true">◎</span><span class="pk-title">'+escHtml(x.t)+'</span>'+
      '<span class="pk-when num">'+escHtml(x.w)+'</span><span class="pk-stamp" aria-label="済">済</span></li>'));
  });
  for(var k=n;k<PICK_MAX;k++){
    ol.appendChild(h('<li class="pk-row blank">'+(k===0?'<span class="pk-hint">カードの「…」から一手を選ぶ</span>':'')+'</li>'));
  }
  el.appendChild(ol);
  if(tm) el.appendChild(h('<p class="pk-tm">明日：'+tm+'件</p>'));
  return el;
}
/* 一覧の中のそのカードまでスクロールして、一瞬強調する。絞り込みで隠れていれば絞り込みを外す */
function goToCard(id){
  function find(){ return document.querySelector('.card[data-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]'); }
  var card=find();
  if(!card){ filter="ALL"; searchKw=""; render(); card=find(); }
  if(!card) return;
  try{ card.scrollIntoView({block:"center", behavior:motionOn()?"smooth":"auto"}); }catch(e){}
  if(motionOn()){ card.classList.add("fresh"); setTimeout(function(){ card.classList.remove("fresh"); }, 2200); }
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
  var open=store.get("ui-summary-open")==="1";
  var total=t.due.length+t.routines.length+t.starts.length;
  var el=h('<section class="sum" aria-label="今日のサマリー"><div class="sum-row"><b class="sum-title">今日</b><div class="sum-cells"></div>'+
    '<button type="button" class="sum-toggle" aria-expanded="'+open+'">'+(open?"▴ 閉じる":"▾ 予定")+'</button></div></section>');
  var cells=el.querySelector(".sum-cells");
  function cell(n,label,title,cls,fn){
    var c=h('<button type="button" class="sum-cell '+(n&&cls?cls:"")+'" title="'+title+'"><small>'+label+'</small><span class="num" data-to="'+n+'">'+n+'</span></button>');
    c.onclick=fn; cells.appendChild(c);
  }
  function go(v){ return function(){ view=v; window.scrollTo(0,0); render(); }; }
  cell(t.due.length,"締切","今日が締切","hot",go("week"));
  cell(t.routines.length,"定期","今日の定期予定（定期予定の一覧へ）","rt",go("rep"));
  cell(t.starts.length,"開始","今日から開始","",go("week"));
  cell(t.stale.length,"滞留","7日以上の滞留（超過の一覧へ）","hot",go("over"));
  el.querySelector(".sum-toggle").onclick=function(){ store.set("ui-summary-open", open?"0":"1"); render(); };
  if(!open) return el;
  var ul=h('<ul class="sum-list"></ul>');
  var lines=t.due.concat(t.routines,t.starts).slice(0,5);
  lines.forEach(function(i){
    var d=parseItemDate(i);
    var when=t.starts.indexOf(i)>=0?"開始":(i.allDay?"終日":fmtTime(d));
    ul.appendChild(h('<li>'+(isRepeating(i)?"🔁 ":"・")+'<span class="num">'+escHtml(when)+'</span>　'+escHtml(i.title)+'</li>'));
  });
  if(!lines.length) ul.appendChild(h('<li class="c-ink3">今日の予定はありません</li>'));
  var more=total-lines.length;
  if(more>0) ul.appendChild(h('<li class="c-ink3">ほか '+more+' 件</li>'));
  el.appendChild(ul);
  return el;
}

function renderListBody(){
  var body=document.getElementById("listBody");
  if(!body) return;
  body.innerHTML="";
  // 定期予定は次の回だけを並べる（この端末だけの設定で隠せる。切り替えは絞り込みの列の「↻ 定期」）
  var showRoutine=store.get("list-show-routine")!=="0";
  var list=activeItems().filter(function(i){ return (filter==="ALL"||i.cat===filter)&&(showRoutine||!isRepeating(i))&&matchesSearch(i); }).sort(sortByDue);
  if(!list.length){
    var msg=searchKw.trim()
      ? '<div class="empty mt-18"><b>見つかりませんでした</b>「'+escHtml(searchKw)+'」に一致する締切はありません。</div>'
      : '<div class="empty mt-18"><b>登録された締切はありません</b>下のボタンから最初の締切を登録してください。</div>';
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
      var lbl=h('<div class="group-label">'+g[0]+(stale?'（うち '+stale+' 件が7日以上）':'')+'<button type="button" class="group-link">超過の一覧 ›</button></div>');
      lbl.querySelector("button").onclick=function(){ view="over"; window.scrollTo(0,0); render(); };
      body.appendChild(lbl);
    } else {
      body.appendChild(h('<div class="group-label">'+g[0]+'</div>'));
    }
    arr.forEach(function(i){ body.appendChild(cardOf(i)); });
  });
  var all=h('<div class="list-foot"><button class="act primary">表示中の締切をまとめてカレンダーへ書き出す</button><button type="button" class="act">定期予定の一覧 ›</button></div>');
  all.children[0].onclick=function(){ downloadIcsPreferWorker(list,"deadlines"); };
  all.children[1].onclick=function(){ view="rep"; window.scrollTo(0,0); render(); };
  body.appendChild(all);
}

/* 期限を過ぎたものだけを集める。経過が長いものほど上に出す */
/* タブの無い画面（超過・定期予定）の見出し。一覧へ戻るボタンを付ける */
function subHead(title){
  var el=h('<div class="sub-head"><button type="button" class="nav back">‹ 一覧</button><h2>'+escHtml(title)+'</h2></div>');
  el.querySelector("button").onclick=function(){ view="list"; window.scrollTo(0,0); render(); };
  return el;
}
function renderOverdue(){
  main.appendChild(subHead("超過"));
  main.appendChild(filterBar());
  // 完了にし忘れた定期予定の回もここに出す（完了にすると次回へ進む）
  var list=activeItems()
    .filter(function(i){ return (filter==="ALL"||i.cat===filter)&&parseItemDate(i)<new Date(); })
    .sort(function(a,b){ return overdueDays(b)-overdueDays(a); });

  if(!list.length){
    main.appendChild(h('<div class="empty mt-18"><b>超過しているものはありません</b>すべて期限内です。</div>'));
    return;
  }
  var stale=list.filter(isStale).length;
  main.appendChild(h('<div class="notice mt-14">'+
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
  var bulk=h('<div class="mt-20"><button class="act danger act-lg">7日以上のものをまとめて完了にする</button></div>');
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
    // 予定のない日は細い行に詰める（予定のある日を一画面に収めやすくする）
    // 見出しは「日付／曜日／今日・明日」の3つの欄に分け（styles.css の .wday-head）、どの行も同じ位置から始める。
    // 予定のない日の祝日名は、見出しの欄を増やさないよう「予定なし」の側に出す
    var row=h('<div class="wday'+(k===0?" is-today":"")+(hit.length?"":" wday-empty")+'">'+
      '<div class="wday-head tap'+dowCls+'" title="この日を時間軸で見る"><span class="num wcol-date">'+(d.getMonth()+1)+'/'+d.getDate()+'</span>'+
      '<span class="wcol-dow"><span class="wdow">（'+DOW[d.getDay()]+'）</span><span class="wgo">›</span></span>'+
      '<span class="wcol-tag">'+(label?'<span class="wtag">'+label+'</span>':'')+'</span>'+
      (hol&&hit.length?'<span class="wdow w-full">'+escHtml(hol)+'</span>':'')+'</div>'+
      '<div class="wday-body"></div></div>');
    row.querySelector(".wday-head").onclick=(function(key){ return function(){ openDayView(key); }; })(key);
    var body=row.querySelector(".wday-body");
    if(!hit.length){
      body.appendChild(h('<div class="wnone">予定なし'+(hol?'<span class="wnone-hol">'+escHtml(hol)+'</span>':'')+'</div>'));
    } else {
      hit.forEach(function(i){
        var isDue=(toLocalISO(parseItemDate(i))===key);
        var mark=isRepeating(i)?"🔁":(isDue?"・":"↳");
        var when=i.allDay?"終日":(isDue?fmtTime(parseItemDate(i)):"期間中");
        var item=h('<div class="witem'+(isRepeating(i)?" routine":"")+'">'+
          '<span class="wmark">'+mark+'</span>'+
          swatch(itemColor(i))+catIcon(i.cat)+'<span class="wtitle">'+escHtml(i.title)+'</span>'+
          '<span class="wcat">'+escHtml(i.cat||"")+'</span>'+
          '<span class="wtime num">'+escHtml(when)+'</span></div>');
        item.onclick=(function(key){ return function(){ view="cal"; selDay=key; calRef=new Date(key+"T00:00:00"); render(); }; })(key);
        body.appendChild(item);
      });
    }
    wrap.appendChild(row);
  }
  main.appendChild(wrap);
  if(!total) main.appendChild(h('<div class="empty mt-14">この7日間に予定はありません。</div>'));
  main.appendChild(h('<p class="note mt-10">日付をタップすると、その日を時間軸で表示します。</p>'));
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
    (hol?' <span class="note c-red">'+escHtml(hol)+'</span>':'')+'</h2><div class="row"></div></div>');
  function shift(n){ var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()+n); openDayView(toLocalISO(x)); }
  var prev=h('<button class="nav" title="前の日">‹</button>'), next=h('<button class="nav" title="次の日">›</button>');
  var back=h('<button class="nav nav-wide">今週へ</button>');
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
  for(var hr=0;hr<24;hr++) grid.appendChild(h('<div class="dv-hour" data-st="top:calc('+hr+' * var(--hh))">'+hr+':00</div>'));

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
    var el=h('<div class="dv-ev '+cls+(byCat?" bycat":"")+'" data-st="top:'+top+'px;height:'+(mins/60*hh-2)+'px;'+(byCat?'--cc:'+itemColor(i)+';':'')+
      'left:calc('+(ev.col*100/ev.ncol)+'% + 2px);width:calc('+(100/ev.ncol)+'% - 4px)">'+
      '<b>'+(isRepeating(i)?"🔁 ":"")+escHtml(i.title)+'</b><span class="num">'+
      (i.start?fmtTime(ev.s)+"–":"")+fmtTime(ev.e)+(i.start?"":" 締切")+'</span></div>');
    el.onclick=function(){ openFromDayView(i); };
    grid.appendChild(el);
  });
  var isToday=(key===toLocalISO(new Date()));
  if(isToday){
    var n=new Date();
    grid.appendChild(h('<div class="dv-now" data-st="top:'+((n.getHours()*60+n.getMinutes())/60*hh)+'px"></div>'));
  }
  scroll.appendChild(grid);
  main.appendChild(scroll);
  if(!all.length) main.appendChild(h('<div class="empty mt-12">この日の予定はありません。</div>'));
  // 今日なら今の時刻の少し前、それ以外は最初の予定か8時あたりから見せる
  var firstH=isToday?Math.max(0,new Date().getHours()-1):(evs.length?Math.max(0,evs[0].s.getHours()-1):8);
  setTimeout(function(){ scroll.scrollTop=firstH*hh; },0);
}
/* 日表示から予定を開く。繰り返しの回は表示用の複製なので、定期予定タブへ移る */
function openFromDayView(i){
  if(isRepeating(i)){ view="rep"; window.scrollTo(0,0); render(); toast("定期予定はこの一覧から編集・完了できます"); return; }
  var orig=db.items.filter(function(x){ return x.id===i.id; })[0];
  if(orig) openDialog(orig);
}

function renderRepeat(){
  main.appendChild(subHead("定期予定"));
  main.appendChild(filterBar());
  var list=activeItems().filter(function(i){ return (filter==="ALL"||i.cat===filter)&&isRepeating(i); }).sort(sortByDue);
  if(!list.length){
    main.appendChild(h('<div class="empty mt-18"><b>定期予定はありません</b>締切を登録するとき「繰り返し」を選ぶと、ここにまとまります。</div>'));
    return;
  }
  var labels={weekly:"毎週",biweekly:"隔週",monthly:"毎月",yearly:"毎年"};
  ["weekly","biweekly","monthly","yearly"].forEach(function(rep){
    var arr=list.filter(function(i){ return i.rep===rep; });
    if(!arr.length) return;
    main.appendChild(h('<div class="group-label">'+labels[rep]+'</div>'));
    arr.forEach(function(i){
      var card=cardOf(i);
      // 取りやめた回があれば一覧を出し、戻せるようにする（2列のときも離れないよう、カードと一緒に包む）
      if(!(i.skip&&i.skip.length)){ main.appendChild(card); return; }
      var pair=h('<div class="card-pair"></div>');
      pair.appendChild(card);
      main.appendChild(pair);
      var box=h('<div class="skipbox">'+
        '<div class="note note-label">取りやめた回</div>'+
        '<div class="row"></div></div>');
      i.skip.slice().sort().forEach(function(k){
        var b=h('<button class="act">'+escHtml(k)+' を戻す</button>');
        b.onclick=(function(id,key){ return function(){ unskipOccurrence(id,key); }; })(i.id,k);
        box.querySelector(".row").appendChild(b);
      });
      pair.appendChild(box);
    });
  });
  var all=h('<div class="mt-20"><button class="act primary act-lg">定期予定をまとめてカレンダーへ書き出す</button></div>');
  all.querySelector("button").onclick=function(){ downloadICS(list,"routines"); };
  main.appendChild(all);
}

function renderDone(){
  var list=db.items.filter(function(i){ return i.done; }).sort(sortByDue).reverse();
  main.appendChild(achievementGrid());
  main.appendChild(h('<div class="group-label">完了した締切</div>'));
  if(!list.length){ main.appendChild(h('<div class="empty"><b>まだありません</b>完了にした締切がここに残ります。</div>')); return; }
  list.forEach(function(i){ main.appendChild(cardOf(i)); });
}

/* 週の負荷の閾値。週次レビューの負荷予報（deadline-data の send_digest.sh）と同じ値にそろえる */
var LOAD_WARN=6, CAT_WARN=3;
/* 負荷の集計：日ごとの「締切」の一覧。完了済みと、自動完了の予定（締切を過ぎると自動で完了になる予定）は数えない */
function buildLoadByDay(items){
  var loadByDay={};
  items.forEach(function(i){
    if(i.done || i.autoComplete) return;
    var dk=toLocalISO(new Date(i.due));
    (loadByDay[dk]=loadByDay[dk]||[]).push(i);
  });
  return loadByDay;
}
/* カレンダー右端の「週」の列：その週の未完了の件数。多い週は ⚠ を付け、内訳を title に出す */
function weekCell(n, cats){
  var names=Object.keys(cats).sort(function(a,b){ return cats[b]-cats[a]; });
  var warn=n>=LOAD_WARN || names.some(function(c){ return cats[c]>=CAT_WARN; });
  var detail=names.map(function(c){ return c+" "+cats[c]+(cats[c]>=CAT_WARN?" ⚠":""); }).join("・");
  var label=n?"この週の締切 "+n+" 件"+(warn?"（多め）":"")+(detail?"："+detail:""):"この週の締切はありません";
  return h('<div class="wk'+(warn?" warn":"")+'" title="'+escHtml(label)+'" aria-label="'+escHtml(label)+'">'+
    (n?(warn?'<i aria-hidden="true">⚠</i>':'')+'<span class="num">'+n+'</span>':'')+'</div>');
}

function renderCal(){
  main.appendChild(filterBar());
  // 広い画面（960px以上）では、月の表と選んだ日の予定を左右に並べる（styles.css）
  var layout=h('<div class="cal-layout"><div class="cal-main"></div><div class="cal-side"></div></div>');
  var cm=layout.querySelector(".cal-main"), side=layout.querySelector(".cal-side");
  main.appendChild(layout);
  var y=calRef.getFullYear(), m=calRef.getMonth();
  var head=h('<div class="cal-head"><h2><span class="num">'+y+"."+pad(m+1)+'</span></h2><div class="row"></div></div>');
  var prev=h('<button class="nav">‹</button>'), today=h('<button class="nav nav-wide">今月</button>'), next=h('<button class="nav">›</button>');
  prev.onclick=function(){ calRef=new Date(y,m-1,1); selDay=null; render(); };
  next.onclick=function(){ calRef=new Date(y,m+1,1); selDay=null; render(); };
  today.onclick=function(){ calRef=new Date(); selDay=null; render(); };
  head.querySelector(".row").append(prev,today,next);
  cm.appendChild(head);

  var showRoutine=store.get("cal-show-routine")!=="0"; // 定期予定の帯を出すか（この端末だけの表示設定）
  var mode=calColorMode(); // 帯の色分け：カテゴリ / 締切の近さ（この端末だけの表示設定）
  var grid=h('<div class="grid"></div>');
  DOW.forEach(function(d,i){ grid.appendChild(h('<div class="dow'+(i===0?" sun":i===6?" sat":"")+'">'+d+'</div>')); });
  grid.appendChild(h('<div class="dow wk-h" title="その週（日〜土）の未完了の件数">週</div>'));
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

  // 負荷：その日が締切の未完了の件数（定期予定の回も含む。自動完了の予定は数えない。帯の表示設定には左右されない）。
  // 週の合計と1カテゴリの件数は、週次レビューの負荷予報（send_digest.sh の LOAD_WARN / CAT_WARN）と同じ閾値で ⚠ を付ける
  var loadByDay=buildLoadByDay(items);
  var wkN=0, wkCats=Object.create(null);

  for(var k=0;k<42;k++){
    var d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+k);
    var key=toLocalISO(d);
    var dayLoad=(loadByDay[key]||[]).length;
    wkN+=dayLoad;
    (loadByDay[key]||[]).forEach(function(i){ var c=i.cat||"その他"; wkCats[c]=(wkCats[c]||0)+1; });
    var hol=holidayName(key);
    var dayTitle=[hol, dayLoad?"締切 "+dayLoad+" 件":""].filter(Boolean).join("・");
    var dayLabel=(d.getMonth()+1)+"月"+d.getDate()+"日"+(dayTitle?" "+dayTitle:"");
    var day=h('<button class="day'+(d.getMonth()!==m?" out":"")+(key===todayKey?" is-today":"")+(selDay===key?" sel":"")+(hol?" holiday":"")+
      (dayLoad?" load"+Math.min(dayLoad,3):"")+'" aria-label="'+escHtml(dayLabel)+'" '+
      (dayTitle?'title="'+escHtml(dayTitle)+'"':'')+'><span class="d">'+d.getDate()+'</span>'+
      (dayLoad?'<span class="cnt" aria-hidden="true">'+(dayLoad>=3?"3+":dayLoad)+'</span>':'')+ // スマホ幅では、印が細くても件数が読めるように数字を添える
      (hol?'<span class="holname">'+escHtml(hol)+'</span>':'')+'</button>');
    // 帯：定期予定は、全体で隠しているときと、その予定だけ隠す設定のときは出さない
    var hit=hitsOn(key).filter(function(i){ return !isRepeating(i) || (showRoutine && !i.calHide); });
    hit.slice(0,3).forEach(function(i){
      var isDue=(toLocalISO(new Date(i.due))===key);
      // 定期予定は緑、それ以外は緊急度の色。期間の途中は薄い帯にする
      var cls=i.done?"done":(isRepeating(i)?"routine":statusOf(i));
      var style=(mode==="cat"&&!i.done)?' data-st="background:'+itemColor(i)+'"':'';
      day.appendChild(h('<span class="dot '+cls+(isDue?"":" span")+'"'+style+' title="'+escHtml(i.title+"（"+(i.cat||"その他")+"）")+'"></span>'));
    });
    (function(key){ day.onclick=function(){ selDay=(selDay===key?null:key); render(); }; })(key);
    grid.appendChild(day);
    if(k%7===6){ grid.appendChild(weekCell(wkN, wkCats)); wkN=0; wkCats=Object.create(null); }
  }
  cm.appendChild(grid);
  // 表の下：1行の凡例（詳しい説明は「？」で開く）と、表示の切り替え
  var foot=h('<div class="cal-foot"><div class="cal-legend"><span class="lg-sw load1"></span>1件 <span class="lg-sw load2"></span>2件 <span class="lg-sw load3"></span>3件以上 <span class="lg-warn">⚠</span>混む週'+
    '<details class="cal-help"><summary aria-label="凡例の説明">？</summary>'+
    '<p>マスの濃さはその日の未完了の締切の数（1・2・3件以上。自動完了の予定は数えません）。右端は週の件数で、'+LOAD_WARN+'件以上か1カテゴリ'+CAT_WARN+'件以上の週に ⚠</p></details></div></div>');
  // 定期予定の帯をまとめて出し入れする（この端末だけの表示設定）
  var rtToggle=h('<label class="cal-opt"><input type="checkbox"'+(showRoutine?" checked":"")+'>定期予定の帯を表示</label>');
  rtToggle.querySelector("input").onchange=function(){ store.set("cal-show-routine", this.checked?"1":"0"); render(); };
  // 帯の色分け：カテゴリの色 / 締切の近さ（状態）の色（この端末だけの表示設定）
  var modeRow=h('<div class="cal-opt cal-mode">帯の色：</div>');
  [["cat","カテゴリ"],["status","締切の近さ"]].forEach(function(p){
    var b=h('<button type="button" class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", mode===p[0]?"true":"false");
    b.onclick=function(){ store.set("cal-color-mode", p[0]); render(); };
    modeRow.appendChild(b);
  });

  foot.appendChild(rtToggle); foot.appendChild(modeRow);
  cm.appendChild(foot);

  if(selDay){
    var sel=hitsOn(selDay).sort(sortByDue);
    var dd=new Date(selDay+"T00:00:00");
    var selHead=h('<div class="sel-title sel-title-row">'+(dd.getMonth()+1)+"月"+dd.getDate()+"日（"+DOW[dd.getDay()]+"）の予定"+
      '<button class="act">時間軸で見る</button></div>');
    selHead.querySelector("button").onclick=function(){ openDayView(selDay); };
    side.appendChild(selHead);
    if(!sel.length) side.appendChild(h('<div class="empty">この日の締切はありません。</div>'));
    else sel.forEach(function(i){ side.appendChild(cardOf(i)); });
  } else {
    side.appendChild(h('<div class="sel-title">日付をタップすると、その日の予定が出ます</div>'));
  }
}

/* サーバー上のindex.htmlを取り直し、ビルドスタンプを比較して表示する */
/* 画面に出す版：「2026-10-31 08:00 v3.1」。日時は build-stamp の先頭、v の後ろは app-version。
   build-stamp の中のハッシュ（[d21065ddfb]）は、最新版かの比較と、ビルドの特定にだけ使い、表には出さない（マウスを載せたときの title に出す） */
function versionInfo(stamp, version){
  var m=/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:\s+\[([0-9a-f]+)\])?/.exec(stamp||"");
  if(!m) return {label:stamp||"不明", build:""};
  return {label:m[1]+(version?" v"+version:""), build:m[2]||""};
}
function versionBadge(info){ return '<b'+(info.build?' title="ビルド '+escHtml(info.build)+'"':'')+'>'+escHtml(info.label)+'</b>'; }
function metaContent(html, name){
  var m=new RegExp('<meta name="'+name+'" content="([^"]*)">').exec(html);
  return m?m[1]:"";
}
function checkVersionDisplay(section, myStamp){
  var el=section.querySelector("#verCheck");
  if(location.protocol==="file:"){ el.textContent="ローカルファイルのため確認できません。"; return; }
  fetch(location.pathname+"?_="+Date.now(),{cache:"no-store"})
    .then(function(res){ return res.ok?res.text():null; })
    .then(function(html){
      if(!html){ el.textContent="サーバーへ接続できませんでした。"; return; }
      var serverStamp=metaContent(html,"build-stamp")||"不明";
      if(serverStamp===myStamp){
        el.innerHTML='<span class="c-blue">✓ 最新版を表示しています</span>';
      } else {
        el.innerHTML='サーバー上の版：'+versionBadge(versionInfo(serverStamp, metaContent(html,"app-version")))+'<br>'+
          '<span class="c-red">画面が古い可能性があります。強制リロード（Ctrl/⌘+Shift+R）するか、'+
          'URLの末尾に <code>?v=2</code> のように付けて開き直してください。</span>';
      }
    })
    .catch(function(){ el.textContent="確認に失敗しました。"; });
}

/* 設定の「バックアップと復元」に入れる、Cloudflare の世代バックアップの一覧と復元。
   一覧はボタンを押したときだけ読む（設定を開くたびには読まない） */
function snapshotSection(){
  var sS=h('<div class="snap-sec"><h4>世代バックアップ（Cloudflare）</h4>'+
    '<p class="note-m mb-10">保存のたびに、前回から30分以上空いていれば、上書き前の内容を残しています（古いものは自動で間引きます）。「この時点に戻す」と、今のCloudflareの内容も世代バックアップに残してから、その時点の内容で置き換えます。使った世代バックアップは消えません。</p>'+
    '<div class="row"></div><p class="snap-status"></p><div class="cat-list snap-list"></div></div>');
  var status=sS.querySelector(".snap-status"), list=sS.querySelector(".snap-list");
  // 入力欄にアクセスキーがあればそれを、なければこの端末に保存したキーを使う
  var snapCfg=function(){
    var box=document.getElementById("syncKey"), key=box && box.value.trim();
    return key ? Promise.resolve(cfConfigFor(key)) : getStoredCfConfig();
  };
  var bLoad=h('<button class="btn">世代バックアップの一覧を読み込む</button>');
  bLoad.onclick=function(){
    status.textContent="読み込んでいます…"; list.textContent="";
    snapCfg().then(function(cfg){
      if(!cfg){ status.textContent="下の「端末間の同期」でアクセスキーを入れてから押してください（「この端末にアクセスキーを保存」にすると、入れ直さずに使えます）。"; return; }
      return cfFetchSnapshots(cfg).then(function(snaps){
        status.textContent=snaps.length ? snaps.length+"件（新しい順）" : "世代バックアップはまだありません。";
        snaps.forEach(function(sn){ list.appendChild(snapshotRow(sn,cfg,status)); });
      });
    }).catch(function(e){ status.textContent="読み込めませんでした："+(e.message||"通信に失敗しました"); });
  };
  sS.querySelector(".row").appendChild(bLoad);
  return sS;
}
/* 一覧の1行。「中身を見る」で件数と先頭の数件を出し、「この時点に戻す」で復元する */
function snapshotRow(sn,cfg,status){
  var when=fmtSnapAt(sn.at);
  var wrap=h('<div></div>');
  var row=h('<div class="cat-row"><span class="cat-name"></span><div class="cat-btns"></div></div>');
  var name=row.querySelector(".cat-name");
  name.textContent=when;
  var meta=h('<span class="note"></span>');
  meta.textContent="版 "+sn.rev+"・"+Math.max(1,Math.round(sn.size/1024))+" KB";
  name.append(document.createElement("br"),meta);
  var detail=h('<div class="snap-detail"></div>');
  detail.hidden=true;
  var bView=h('<button class="act" title="中身を見る">中身</button>');
  bView.onclick=function(){
    detail.hidden=false; detail.textContent="読み込んでいます…";
    cfReadSnapshot(cfg,sn.id).then(function(j){
      var items=j.data.items, titles=items.slice(0,5).map(function(i){ return i && typeof i.title==="string" ? i.title : "（題名なし）"; });
      detail.textContent="締切 "+items.length+"件"+(titles.length?"：":"")+titles.join("、")+(items.length>5?" ほか":"");
      var bBack=h('<button class="act danger act-block">この時点に戻す</button>');
      bBack.onclick=function(){
        var unsynced=hasUnsyncedChanges();
        if(!confirm("Cloudflareのデータを、"+when+"（版 "+sn.rev+"・"+items.length+"件）の内容に戻します。\n\n"+
          "今のCloudflareの内容は、先に世代バックアップへ残します。この世代バックアップも消えません。"+
          (unsynced ? "\n\nこの端末には、まだ同期していない変更があります。戻すと、その変更は失われます。" : "")+"\n\nよろしいですか？")) return;
        status.textContent="戻しています…";
        cfRestoreSnapshot(cfg,j.data).then(function(r){
          status.textContent=when+" の内容に戻しました（"+r.n+"件）。"+(r.quarantined ? r.quarantined+"件は形式が不正のため隔離しました。" : "");
          toast(when+" の内容に戻しました");
          render();
        }).catch(function(e){ status.textContent="戻せませんでした："+(e.message||"通信に失敗しました")+"（この端末のデータは変えていません）"; });
      };
      detail.appendChild(bBack);
    }).catch(function(e){ detail.textContent="中身を読み込めませんでした："+(e.message||"通信に失敗しました"); });
  };
  row.querySelector(".cat-btns").appendChild(bView);
  wrap.append(row,detail);
  return wrap;
}

/* 設定の節は、見出しを押したときだけ開く（プルダウン）。見出しの文字をキーに開閉を覚え、設定を操作して描き直しても閉じ直さない。
   節の中身は動かさず、クラスで出し入れする（節の要素への参照を壊さないため）。同期が働いていない理由（.sync-warn）があるときは、最初から開く */
var _secOpen={};
function settingsAccordion(el){
  var head=el.querySelector(":scope > h3");
  if(!head || !el.classList.contains("sec")) return;
  var key=head.textContent.replace(/（\d+件）/,"").trim();
  var open=!!_secOpen[key] || !!el.querySelector(":scope > .sync-warn");
  el.classList.add("acc"); el.classList.toggle("open", open);
  head.setAttribute("role","button"); head.tabIndex=0; head.setAttribute("aria-expanded", open?"true":"false");
  function toggle(){
    var now=!el.classList.contains("open");
    el.classList.toggle("open", now); head.setAttribute("aria-expanded", now?"true":"false"); _secOpen[key]=now;
  }
  head.onclick=toggle;
  head.onkeydown=function(e){ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); toggle(); } };
}

/* 設定画面の組み立て：グループの見出しと、先頭の目次（押すとそのグループへ移る）を置く。
   id や href を使わず、要素の位置から直接スクロールする（main の描き直しで id がずれないように） */
var SETTINGS_GROUPS=[["sync","同期とアクセスキー"],["notify","通知"],["cat","カテゴリとテンプレート"],["display","表示"],["data","データ"],["about","このアプリについて"]];
function settingsAssemble(groups){
  var toc=h('<nav class="set-toc" aria-label="設定の目次"></nav>');
  var heads={};
  SETTINGS_GROUPS.forEach(function(p){
    if(!groups[p[0]].length) return;
    var b=h('<button type="button">'+escHtml(p[1])+'</button>');
    b.onclick=function(){ // 上に固定されている見出し（header）の分だけ手前で止める
      var top=heads[p[0]].getBoundingClientRect().top+window.pageYOffset-document.querySelector("header").offsetHeight-8;
      window.scrollTo({top:Math.max(0,top), behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
    };
    toc.appendChild(b);
  });
  main.appendChild(toc);
  SETTINGS_GROUPS.forEach(function(p){
    if(!groups[p[0]].length) return;
    var hd=h('<h2 class="set-group">'+escHtml(p[1])+'</h2>');
    heads[p[0]]=hd;
    main.appendChild(hd);
    groups[p[0]].forEach(function(el){ settingsAccordion(el); main.appendChild(el); });
  });
}
/* ---- 購読用 URL（Cloudflare）。押したときだけ Worker から取り、画面に出したままにしない ---- */
var FEED_URL_SHOW_MS=60000;
function copyText(text){
  if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise(function(resolve,reject){ // 古い端末向け：見えない入力欄に入れて選択し、コピーする
    var ta=document.createElement("textarea");
    ta.value=text; ta.setAttribute("readonly",""); ta.className="offscreen";
    document.body.appendChild(ta); ta.select();
    var ok=false; try{ ok=document.execCommand("copy"); }catch(e){}
    ta.remove(); ok?resolve():reject(new Error("copy"));
  });
}
/* 定時の通知（Discord・メール）が届いたか。押したときだけ Worker の記録（notify_log）を読む */
var NOTIFY_ROWS=[["morning","朝の締切一覧"],["evening","夜の再通知"],["weekly","週次レビュー"],["mail-morning","朝のメール"],["mail-evening","夜のメール"]];
function fmtNotifyAt(sec){
  var d=new Date(sec*1000);
  return (d.getMonth()+1)+"/"+d.getDate()+" "+d.getHours()+":"+pad(d.getMinutes());
}
function notifyLogSection(){
  var el=h('<div class="sec"><h3>定時の通知が届いたか</h3>'+
    '<p>朝・夜の Discord の通知とメールを、最後にいつ送れたかを確かめます。届かなかった日は、次に届いた Discord の通知の最後にも1行で出ます。</p>'+
    '<div class="row"></div><div class="notify-log" role="status"></div></div>');
  var out=el.querySelector(".notify-log");
  var b=h('<button class="btn">前回届いた日時を確かめる</button>');
  b.onclick=function(){
    out.textContent="確認しています…";
    getStoredCfConfig().then(function(cfg){
      if(!cfg){ out.textContent="先に「同期とアクセスキー」でアクセスキーを入れてください。"; return; }
      return cfGetJson(cfg, cfg.api.replace(/\/data$/,"/notify-log")).then(function(j){
        out.textContent="";
        NOTIFY_ROWS.forEach(function(r){
          var at=j && j.last ? j.last[r[0]] : null;
          var line=document.createElement("div");
          line.textContent=r[1]+"："+(at ? fmtNotifyAt(at) : "記録なし");
          out.appendChild(line);
        });
        var fails=(j && Array.isArray(j.failures)) ? j.failures : [];
        var label={}; NOTIFY_ROWS.forEach(function(r){ label[r[0]]=r[1]; });
        var f=document.createElement("div");
        f.className=fails.length ? "notify-fail" : "note";
        f.textContent=fails.length
          ? "届いていない通知（直近7日）："+fails.map(function(x){ var p=String(x.day).split("-"); return Number(p[1])+"/"+Number(p[2])+" "+(label[x.kind]||x.kind); }).join("、")
          : "直近7日で、届かなかった通知はありません。";
        out.appendChild(f);
      });
    }).catch(function(err){
      out.textContent=(err && err.status===401) ? "アクセスキーが違います。" : "確かめられませんでした："+((err && err.message)||"");
    });
  };
  el.querySelector(".row").appendChild(b);
  return el;
}
/* ========== WebClass の成績表 CSV の取り込み ==========
   読み取りと対応づけは webclass-import.js（DTWebClass）。CSV の中身は端末の中だけで処理し、サーバーには送らない */
function webclassSection(){
  var n=db.wcExcluded.length;
  var el=h('<div class="sec"><h3>WebClass の CSV を取り込む</h3>'+
    '<p>WebClass の「成績表」で書き出した CSV を選ぶと、締切の候補を一覧で確かめてから登録できます。CSV はこの端末の中だけで読み、どこにも送りません。'+
    '選ばなかった項目は、次回から出しません（締切が変わったら、また出します）。</p>'+
    '<div class="row"></div><p class="note wc-ex-note"></p></div>');
  var input=h('<input type="file" accept=".csv,text/csv" hidden>');
  var b=h('<button class="btn">CSV を選ぶ</button>');
  b.onclick=function(){ input.click(); };
  input.onchange=function(){
    var f=input.files && input.files[0]; input.value="";
    if(!f) return;
    if(f.size>WC.WC_MAX_BYTES){ toast("ファイルが大きすぎます（2MB まで）"); return; }
    f.arrayBuffer().then(function(buf){
      var r=WC.wcParse(WC.wcDecode(new Uint8Array(buf)));
      if(!r.entries.length){ toast("取り込める行がありませんでした"); return; }
      openWebclassPreview(r);
    }).catch(function(e){ toast(e && e.message ? e.message : "この CSV は読み込めませんでした"); });
  };
  el.querySelector(".row").append(b,input);
  var note=el.querySelector(".wc-ex-note");
  if(n){
    note.textContent="次回から出さない項目："+n+"件 ";
    var clr=h('<button class="act">除外リストを空にする</button>');
    clr.onclick=function(){
      if(!confirm("除外リスト（"+n+"件）を空にします。次に CSV を読むと、選ばなかった項目もまた出ます。よろしいですか？")) return;
      db.wcExcluded=[]; save(); scheduleAutoSync(); render(); toast("除外リストを空にしました");
    };
    note.appendChild(clr);
  } else note.hidden=true;
  return el;
}
var WC_FILTERS=[["all","すべて"],["open","期限内"],["over","期限切れ"],["done","提出済み"],["self","自習用"],["nodue","締切なし"]];
function wcMatch(row,f,now){
  var e=row.e;
  if(f==="open") return !e.noDue && e.due>=now;
  if(f==="over") return !e.noDue && e.due<now && !e.submitted;
  if(f==="done") return e.submitted;
  if(f==="self") return e.selfStudy;
  if(f==="nodue") return e.noDue;
  return true;
}
/* プレビュー。読んだ候補をカードで並べ、選んだものだけを「取り込む」で登録する */
function openWebclassPreview(parsed){
  var now=new Date();
  var rows=WC.wcPlan(parsed.entries, db.items, db.wcExcluded, now).filter(function(r){ return r.state!=="registered"; });
  var sel=rows.map(function(r){ return r.selected; });
  var state={filter:"all", q:"", showEx:false};
  var dlg=h('<dialog class="wc-dlg"><div class="dlg-in">'+
    '<h2>WebClass の CSV から取り込む</h2>'+
    '<p class="wc-sum note"></p>'+
    '<div class="wc-tools"><div class="row wc-filters"></div>'+
    '<input type="search" class="wc-q" placeholder="教材名・コース名で絞り込む" aria-label="教材名・コース名で絞り込む">'+
    '<div class="row wc-bulk"><button type="button" class="act" data-bulk="1">表示中を全部選ぶ</button><button type="button" class="act" data-bulk="0">表示中を全部外す</button>'+
    '<label class="wc-ex"><input type="checkbox"> 除外した項目も表示</label></div></div>'+
    '<div class="wc-list" role="list"></div>'+
    '<div class="dlg-acts"><button type="button" class="btn" data-act="cancel">やめる</button><button type="button" class="btn fill" data-act="go">取り込む</button></div>'+
    '</div></dialog>');
  var list=dlg.querySelector(".wc-list"), sum=dlg.querySelector(".wc-sum"), goBtn=dlg.querySelector('[data-act="go"]');
  WC_FILTERS.forEach(function(f){
    var c=h('<button type="button" class="chip">'+f[1]+'</button>');
    c.setAttribute("aria-pressed", f[0]===state.filter?"true":"false");
    c.onclick=function(){ state.filter=f[0]; dlg.querySelectorAll(".wc-filters .chip").forEach(function(x){ x.setAttribute("aria-pressed","false"); }); c.setAttribute("aria-pressed","true"); draw(); };
    dlg.querySelector(".wc-filters").appendChild(c);
  });
  dlg.querySelector(".wc-q").oninput=function(){ state.q=WC.wcNorm(this.value).toLowerCase(); draw(); };
  dlg.querySelector(".wc-ex input").onchange=function(){ state.showEx=this.checked; draw(); };
  function visible(){
    var out=[];
    rows.forEach(function(r,i){
      if(r.state==="excluded" && !state.showEx) return;
      if(!wcMatch(r,state.filter,now)) return;
      if(state.q && WC.wcNorm(r.e.course+" "+r.e.title).toLowerCase().indexOf(state.q)<0) return;
      out.push(i);
    });
    return out;
  }
  dlg.querySelectorAll("[data-bulk]").forEach(function(b){
    b.onclick=function(){ var on=b.getAttribute("data-bulk")==="1"; visible().forEach(function(i){ if(!rows[i].e.noDue) sel[i]=on; }); draw(); };
  });
  function counts(){
    var picked=0, rest=0;
    rows.forEach(function(r,i){ if(sel[i]) picked++; else if(r.state!=="excluded") rest++; });
    return {picked:picked, rest:rest};
  }
  function draw(){
    var idx=visible(), c=counts(), groups=[], byCourse={};
    sum.textContent="候補 "+rows.filter(function(r){ return r.state!=="excluded"; }).length+"件（表示中 "+idx.length+"件）・選んだもの "+c.picked+"件";
    goBtn.textContent=c.picked?("取り込む（"+c.picked+"件）"):"取り込む";
    idx.forEach(function(i){ var k=rows[i].e.course; if(!byCourse[k]){ byCourse[k]=[]; groups.push(k); } byCourse[k].push(i); });
    list.textContent="";
    if(!idx.length){ list.appendChild(h('<p class="note">表示する項目はありません。</p>')); return; }
    groups.forEach(function(course){
      var g=h('<section class="wc-group"><div class="wc-ghead"><h3></h3><button type="button" class="act">全部選ぶ</button><button type="button" class="act">全部外す</button></div></section>');
      g.querySelector("h3").textContent=rows[byCourse[course][0]].e.courseName;
      var gb=g.querySelectorAll(".wc-ghead .act");
      gb[0].onclick=function(){ byCourse[course].forEach(function(i){ if(!rows[i].e.noDue) sel[i]=true; }); draw(); };
      gb[1].onclick=function(){ byCourse[course].forEach(function(i){ sel[i]=false; }); draw(); };
      byCourse[course].forEach(function(i){ g.appendChild(wcCard(rows[i], i)); });
      list.appendChild(g);
    });
  }
  function wcCard(r,i){
    var e=r.e, flags=WC.wcFlags(e,now);
    if(r.state==="changed") flags.unshift("締切が変更");
    if(r.state==="excluded") flags.unshift("除外済み");
    var when=e.noDue?"":(fmtDue(e.due,false)+"・"+wcRemain(e.due,now)); // 締切なしは目印だけで示す
    var card=h('<label class="wc-card" role="listitem"><input type="checkbox"><span class="wc-body"><span class="wc-title"></span>'+
      '<span class="wc-meta"><span class="wc-when"></span><span class="wc-flags"></span></span></span></label>');
    var cb=card.querySelector("input");
    cb.checked=!!sel[i]; cb.disabled=e.noDue;
    if(e.noDue) card.classList.add("off");
    cb.onchange=function(){ sel[i]=cb.checked; var c=counts(); goBtn.textContent=c.picked?("取り込む（"+c.picked+"件）"):"取り込む";
      sum.textContent=sum.textContent.replace(/選んだもの \d+件/,"選んだもの "+c.picked+"件"); };
    card.querySelector(".wc-title").textContent=e.title;
    card.querySelector(".wc-when").textContent=when+(r.state==="changed"?"（今の締切："+fmtDue(new Date(r.item.due),false)+"）":"");
    var fl=card.querySelector(".wc-flags");
    flags.forEach(function(f){ var b=document.createElement("span"); b.className="wc-flag"+(f==="期限切れ"||f==="締切が変更"?" warn":""); b.textContent=f; fl.appendChild(b); });
    return card;
  }
  dlg.querySelector('[data-act="cancel"]').onclick=function(){ dlg.close(); };
  goBtn.onclick=function(){
    var c=counts();
    if(!c.picked && !c.rest){ dlg.close(); return; }
    if(!confirm((c.picked?c.picked+"件を登録します。":"登録する項目はありません。")+(c.rest?"\n選ばなかった "+c.rest+"件は、次回から出しません。":"")+"\nよろしいですか？")) return;
    var out=webclassApply(rows, sel, now);
    dlg.close();
    toast("WebClass から "+out.added+"件を登録"+(out.updated?"・"+out.updated+"件の締切を更新":"")+"しました");
  };
  dlg.addEventListener("close",function(){ dlg.remove(); });
  document.body.appendChild(dlg);
  draw();
  dlg.showModal();
}
function wcRemain(due,now){
  if(due<now){ var od=daysBetween(due,now); return od?od+"日超過":"期限切れ"; }
  var n=daysBetween(now,due);
  return n===0?"今日":n===1?"明日":"あと"+n+"日";
}
/* 選んだものを登録（締切が変わったものは既存の締切の日時を更新）し、選ばなかったものを除外リストに入れる */
function webclassApply(rows, sel, now){
  var added=0, updated=0, today=toLocalISO(now), ex={};
  db.wcExcluded.forEach(function(x){ ex[x.k]=x; });
  rows.forEach(function(r,i){
    var e=r.e;
    if(sel[i] && !e.noDue){
      if(r.item){ r.item.due=e.due.toISOString(); r.item.seq=(r.item.seq||0)+1; updated++; } // 登録済みで締切が変わったもの
      else {
        var id="d"+Date.now().toString(36)+Math.random().toString(36).slice(2,6)+added.toString(36);
        db.items.push(WC.wcToItem(e,id,now)); added++;
      }
      delete ex[e.hash];
    } else if(!sel[i]){
      // 選ばなかったもの（締切の変更を見送ったものも含む）は、次回から出さない。締切が変われば、また出る
      ex[e.hash]={k:e.hash, due:e.dueText, at:today};
    }
  });
  if(added && db.categories.indexOf(WC.WC_CAT)<0) db.categories.push(WC.WC_CAT); // 取り込むカテゴリーが無ければ足す
  db.wcExcluded=WC.wcCleanExcluded(Object.keys(ex).map(function(k){ return ex[k]; }));
  save(); scheduleAutoSync(); render();
  return {added:added, updated:updated};
}
function feedUrlSection(){
  var el=h('<div class="sec"><h3>カレンダーで購読する</h3>'+
    '<p>iPhone の「設定 → カレンダー → アカウント → アカウントを追加 → その他 → 照会カレンダーを追加」に購読用 URL を入れると、締切が標準カレンダーに自動で並びます（メモは含みません。約1時間ごとに更新されます）。</p>'+
    '<p class="note">この URL を知っている人は、締切（メモを除く）を見られます。画面に出したままにせず、共有しないでください。</p>'+
    '<div class="row"></div><div class="feed-box" hidden><input type="text" readonly aria-label="購読用 URL"><div class="row"></div></div>'+
    '<p class="mt-8" role="status"></p></div>');
  var msg=el.querySelector("p[role=status]"), box=el.querySelector(".feed-box"), input=box.querySelector("input"), timer=null;
  function hide(){ clearTimeout(timer); input.value=""; box.hidden=true; }
  var bShow=h('<button class="btn">購読用 URL を表示</button>');
  var bCopy=h('<button class="btn fill">コピー</button>'), bHide=h('<button class="btn">隠す</button>');
  box.querySelector(".row").append(bCopy,bHide);
  bHide.onclick=function(){ hide(); msg.textContent=""; };
  bCopy.onclick=function(){
    copyText(input.value).then(function(){ msg.textContent="コピーしました。"; }, function(){ input.select(); msg.textContent="コピーできませんでした。選択したので、手でコピーしてください。"; });
  };
  bShow.onclick=function(){
    msg.textContent="確認しています…";
    getStoredCfConfig().then(function(cfg){
      if(!cfg){ msg.textContent="先に「同期とアクセスキー」でアクセスキーを入れてください。"; return; }
      return cfGetJson(cfg, cfg.api.replace(/\/data$/,"/feed-url")).then(function(j){
        if(!j || !j.ok){ msg.textContent="購読用のトークン（FEED_TOKEN）が Cloudflare に登録されていません。"; return; }
        input.value=j.url; box.hidden=false; msg.textContent="";
        clearTimeout(timer); timer=setTimeout(function(){ hide(); msg.textContent="安全のため、購読用 URL を隠しました。"; }, FEED_URL_SHOW_MS);
      });
    }).catch(function(err){
      msg.textContent=(err && err.status===401) ? "アクセスキーが違います。" : "取得できませんでした："+((err && err.message)||"");
    });
  };
  el.querySelector(".row").appendChild(bShow);
  return el;
}

function renderSettings(){
  // 節は、よく使う・困ったときに見る順のグループに並べる（作る順番は変えず、置き先だけを決める）
  var groups={sync:[],notify:[],cat:[],display:[],data:[],about:[]};
  function put(g,el){ groups[g].push(el); }
  // このアプリが最新版かどうかを確認できるセクション
  var myStamp=(document.querySelector('meta[name="build-stamp"]')||{}).content||"不明";
  var s0=h('<div class="sec"><h3>バージョン</h3>'+
    '<p>この画面が読み込んでいる版：'+versionBadge(versionInfo(myStamp, (document.querySelector('meta[name="app-version"]')||{}).content))+'</p>'+
    '<p class="note">今日の一手：直近14日のうち '+pickDaysIn(pickDays(), toLocalISO(new Date()), 14)+'日で使用（この端末だけの数）</p>'+
    '<p id="verCheck" class="c-ink3">サーバー上の版を確認しています…</p>'+
    '<div class="row"></div></div>');
  var bCheck=h('<button class="btn">今すぐ確認する</button>');
  bCheck.onclick=function(){ checkVersionDisplay(s0, myStamp); };
  s0.querySelector(".row").appendChild(bCheck);
  put("about",s0);
  checkVersionDisplay(s0, myStamp);

  // 当日リマインド時刻
  var s1=h('<div class="sec"><h3>当日リマインドの時刻</h3><p>カレンダーに書き出すとき、締切当日の通知をこの時刻に入れます。1週間前・前日の通知は締切と同じ時刻に鳴ります。</p></div>');
  var sel=h('<select class="w-max160"></select>');
  for(var hh=5;hh<=22;hh++){ var o=document.createElement("option"); o.value=hh; o.textContent=hh+":00"; if(hh===db.settings.dayHour) o.selected=true; sel.appendChild(o); }
  sel.onchange=function(){ db.settings.dayHour=parseInt(sel.value,10); saveRaw(); toast("当日リマインドを "+sel.value+":00 にしました"); }; // 設定は同期対象外なのでupdatedAtは進めない
  s1.appendChild(sel); put("notify",s1);

  // テンプレート
  var sT=h('<div class="sec"><h3>テンプレート</h3>'+
    '<p>よく登録する締切の雛形です。締切カードの「雛形に保存」から作れます。登録画面で選ぶと内容が入ります（日付は毎回入力してください）。</p>'+
    '<div class="cat-list"></div></div>');
  var tplList=sT.querySelector(".cat-list");
  if(!db.templates.length){
    tplList.appendChild(h('<p class="note-m m0">まだありません。</p>'));
  } else {
    db.templates.forEach(function(t){
      var row=h('<div class="cat-row"><span class="cat-name">'+escHtml(t.name)+
        '<br><span class="note">'+escHtml(t.title)+'　'+catIcon(t.cat)+escHtml(t.cat||"")+
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
  put("cat",sT);

  // ゴミ箱
  var trashSorted=db.trash.slice().sort(function(a,b){ return new Date(b.deletedAt)-new Date(a.deletedAt); });
  var sTr=h('<div class="sec"><h3>ゴミ箱</h3>'+
    '<p>削除した締切は30日間ここに残ります（最大30件）。一覧の「元に戻す」トーストは5秒で消えますが、こちらはいつでも復元できます。</p>'+
    '<div class="cat-list"></div></div>');
  var trList=sTr.querySelector(".cat-list");
  if(!trashSorted.length){
    trList.appendChild(h('<p class="note-m m0">ゴミ箱は空です。</p>'));
  } else {
    trashSorted.forEach(function(t){
      var d=new Date(t.deletedAt);
      var when=(d.getMonth()+1)+"/"+d.getDate()+" "+pad(d.getHours())+":"+pad(d.getMinutes())+" に削除";
      var row=h('<div class="cat-row"><span class="cat-name">'+escHtml(t.item.title)+
        '<br><span class="note">'+escHtml(when)+'</span></span>'+
        '<div class="cat-btns"></div></div>');
      var back=h('<button class="act" title="元に戻す">戻す</button>');
      if(techoStyle()) back.setAttribute("data-sfx","own"); // 手帳風は専用の音（かさっ）。共通の音を重ねない
      back.onclick=function(){ restoreFromTrash(t.trashId); };
      var del=h('<button class="act" title="完全に削除">×</button>');
      del.onclick=function(){
        if(!confirm("「"+t.item.title+"」を完全に削除します。元に戻せません。よろしいですか？")) return;
        purgeTrashItem(t.trashId);
      };
      row.querySelector(".cat-btns").append(back,del);
      trList.appendChild(row);
    });
    var emptyBtn=h('<button class="act danger mt-4">ゴミ箱を空にする</button>');
    emptyBtn.onclick=purgeAllTrash;
    sTr.appendChild(emptyBtn);
  }
  put("data",sTr);

  // 隔離（読み込み時に形式が不正で除外された項目）
  if(db.quarantine.length){
    var sQ=h('<div class="sec"><h3 class="c-red">隔離された項目（'+db.quarantine.length+'件）</h3>'+
      '<p>Cloudflareなどから読み込んだ内容のうち、必須項目（タイトル・締切日など）が壊れていたため取り込めなかったものです。「修復」で内容を直して保存すると一覧に戻ります。放置しても他の機能には影響しません。</p>'+
      '<div class="cat-list"></div></div>');
    var qList=sQ.querySelector(".cat-list");
    db.quarantine.forEach(function(q){
      var rawTitle=(q.raw&&typeof q.raw.title==="string")?q.raw.title:"(タイトル不明)";
      var row=h('<div class="cat-row"><span class="cat-name">'+escHtml(rawTitle)+
        '<br><span class="note c-red">'+escHtml(q.reason)+'</span></span>'+
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
    put("data",sQ);
  }

  // カテゴリ
  var s2=h('<div class="sec"><h3>カテゴリ</h3><p>登録画面の選択肢と、フィルタの並び順になります。「アイコン」で画像を選ぶと、カテゴリーの名前の横に小さく出ます（端末の中で 64px に縮小して保存します）。左の色を押すと、36色のテンプレートかカラーコードで色を選べます（指定しなければ自動で割り振ります）。各カテゴリの「通知」で、カレンダー（.ics）の通知を何日前に鳴らすかを選べます（N日前は締切と同じ時刻、当日は「当日リマインドの時刻」）。</p><div class="cat-list"></div></div>');
  var line=s2.querySelector(".cat-list");
  db.categories.forEach(function(c,idx){
    var row=h('<div class="cat-row cat-row-wrap"><span class="cat-name">'+escHtml(c)+'</span><div class="cat-btns"></div>'+
      '<div class="rem-row">通知：</div></div>');
    var cur=remindersFor(c);
    REMINDER_CHOICES.forEach(function(n){
      var on=cur.indexOf(n)>=0;
      var b=h('<button class="chip">'+(n===0?"当日":n===1?"前日":n+"日前")+'</button>');
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
    row.querySelector(".rem-row").before(catIconRow(c));
    var btns=row.querySelector(".cat-btns");
    function mkBtn(label,title,disabled,fn){
      var b=h('<button class="act" title="'+title+'"'+(disabled?' disabled':'')+'>'+label+'</button>');
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
      delete db.catIcons[c];
      if(filter===c) filter="ALL";
      save(); render(); scheduleAutoSync();
    });
    line.appendChild(row);
  });
  var addRow=h('<div class="row"><input type="text" id="newCat" maxlength="20" placeholder="新しいカテゴリ名" class="grow-140"><button class="btn">追加する</button></div>');
  addRow.querySelector("button").onclick=function(){
    var v=addRow.querySelector("input").value.trim();
    if(!v) return;
    if(db.categories.indexOf(v)>=0){ toast("同じ名前があります"); return; }
    db.categories.push(v); save(); render(); scheduleAutoSync();
  };
  s2.appendChild(addRow); put("cat",s2);

  // 表示
  var s3=h('<div class="sec"><h3>表示テーマ</h3><p>見出しの右上の ◐ でも切り替えられます。まだ選んでいないときは、端末がダークモードなら墨、それ以外は抹茶です。この端末だけの設定です。</p><div class="row"></div></div>');
  THEMES.forEach(function(name){
    var b=h('<button class="chip">'+THEME_NAMES[name]+'</button>');
    b.setAttribute("aria-pressed", currentTheme()===name?"true":"false");
    b.onclick=function(){ setTheme(name); render(); };
    s3.querySelector(".row").appendChild(b);
  });
  put("display",s3);

  // 広い画面の並び
  var s3w=h('<div class="sec"><h3>広い画面の並び</h3><p>PCなど幅の広い画面（960px以上）で、一覧・超過・定期予定・完了のカードを何列に並べるかを選びます。スマホなど狭い画面では、どちらでも1列です。この端末だけの設定です。</p><div class="row"></div></div>');
  [["2","2列"],["1","1列"]].forEach(function(p){
    var b=h('<button class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", (db.settings.cols==="1"?"1":"2")===p[0]?"true":"false");
    b.onclick=function(){ db.settings.cols=p[0]; saveRaw(); render(); }; // 設定は同期対象外なのでupdatedAtは進めない
    s3w.querySelector(".row").appendChild(b);
  });
  put("display",s3w);

  // 完了の演出
  var s3b=h('<div class="sec"><h3>演出</h3><p>「ゲーム風」は、登録したときに「クエスト受注」、完了にしたときに「ミッション達成」、今日の締切を全部片付けたら「全クリア」（ボーナス +'+ALL_CLEAR_BONUS+' EXP）の帯を出します（タップですぐ閉じます）。「手帳風」は帯を出さず、完了にしたカードに「済」の印を押し、全部片付けた日は「皆済」の印を出します。「なし」にすると、延期・休み・削除のカードの動き、期限切れの点滅、数字の数え上げも止まります。端末で「視差効果を減らす」をオンにしている場合は動きを出しません。<br>いまの記録：Lv.'+levelOf(totalExp())+'（累計 '+totalExp()+' EXP・完了 '+db.completions.length+' 件の記録）。記録は同期で端末間に共有され、週次レビューにも載ります。</p><div class="row"></div></div>');
  [["on","ゲーム風"],["techo","手帳風"],["off","なし"]].forEach(function(p){
    var b=h('<button class="chip">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", (db.settings.motion||"on")===p[0]?"true":"false");
    b.onclick=function(){ db.settings.motion=p[0]; saveRaw(); render(); }; // 設定は同期対象外なのでupdatedAtは進めない
    s3b.querySelector(".row").appendChild(b);
  });
  s3b.appendChild(achievementBadges());
  put("display",s3b);

  // 効果音
  var s3c=h('<div class="sec"><h3>効果音</h3><p>締切を登録・完了・削除したときと、画面を切り替えたとき、ボタンを押したときに短い音（ゲームの決定音のような「ぽこっ」）を鳴らします。手帳風の演出を選んでいるときは、ハンコ・朱肉・紙・机の物音（完了は「ぺたっ」、今日の締切を全部片付けた日は「とん、とん…どん」、画面の切り替えは紙をめくる音、ボタンは「こつ」、登録は鉛筆の「カリカリ」、チェックと今日の一手の印は「シュッ」、延期・休みは「ぴたっ」、削除は「くしゃっ」）になります。完了の音は、その日の初回だけです。この端末だけの設定で、初めは「なし」です。端末がマナーモードのときや、ブラウザが音を許可していないときは鳴りません。</p><div class="row"></div></div>');
  [["on","あり"],["off","なし"]].forEach(function(p){
    var b=h('<button class="chip" data-sfx="own">'+p[1]+'</button>');
    b.setAttribute("aria-pressed", (soundOn()?"on":"off")===p[0]?"true":"false");
    b.onclick=function(){
      db.settings.sound=p[0]; saveRaw(); render(); // 設定は同期対象外なのでupdatedAtは進めない
      if(p[0]==="on"){ unlockAudio(); playSfx(techoStyle()?"seal":"done", {always:true}); } // 押した操作の中で鳴らして、音が出ることを確かめられるようにする（手帳風なら手帳風の完了の音）
    };
    s3c.querySelector(".row").appendChild(b);
  });
  put("display",s3c);

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
  var file=h('<input type="file" accept="application/json,.json" hidden>');
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
        if(Array.isArray(d.trash)) db.trash=normalizeTrash(d.trash);
        if(meta.categories) db.categories=meta.categories;
        if(d.catReminders) db.catReminders=cleanCatReminders(d.catReminders);
        if(d.catColors) db.catColors=cleanCatColors(d.catColors);
        if(d.catIcons) db.catIcons=cleanCatIcons(d.catIcons);
        if(d.wcExcluded) db.wcExcluded=WC.wcCleanExcluded(d.wcExcluded);
        adoptCompletions(d);
        if(d.settings) db.settings=Object.assign(db.settings,d.settings);
        delete db.settings.theme; // テーマは端末ごとの設定で、データには入れない
        save(); render();
        toast("読み込みました"+(check.quarantined.length?"（"+check.quarantined.length+"件は形式が不正のため隔離）":""));
      }catch(e){ toast("このファイルは読み込めません。書き出したJSONを選んでください"); }
      file.value="";
    };
    fr.readAsText(f);
  };
  var bIcs=h('<button class="btn">全件を.icsで書き出す</button>');
  bIcs.onclick=function(){ downloadIcsPreferWorker(activeItems().sort(sortByDue),"deadlines-all"); };
  s4.querySelector(".row").append(bOut,bIn,bIcs,file);
  if(CF===true) s4.appendChild(snapshotSection());
  put("data",s4);
  put("data",webclassSection());

  // 端末間の同期（Cloudflare の Worker）。Worker から配信されているアプリでだけ使える
  if(CF===null) cfDetect().then(function(){ if(CF!==null && view==="set") render(); }); // 保存先の判定が終わったら描き直す
  if(CF!==true){
    put("sync",h('<div class="sec"><h3>端末間の同期</h3>'+(CF===null
      ? '<p class="c-ink3">保存先を確認しています…</p>'
      : '<p>この画面では同期できません。Cloudflare から配信されているアプリ（Worker の URL）を開いてください。</p>')+'</div>'));
  } else {
  var s5=h('<div class="sec"><h3>端末間の同期</h3>'+
    '<p>締切データをCloudflareに保存し、端末間で受け渡します。<b>同期する</b>でこの端末の内容を送り、<b>読み込む</b>で他の端末から送られた内容を取り込みます。毎朝のDiscord送信とメールも同じデータを見ています。</p>'+
    '<p class="note">アクセスキーを保存している端末では、この端末に未同期の変更が無いときに限り、Cloudflare上の新しい内容を自動で取り込みます（読み込むボタンを押さなくても、他の端末の更新が反映されます）。アプリを開いたときと画面に戻ったときは、読み終えるまで「読み込み中」を出して編集できなくします（最大4秒。つながらないときは「前回の内容」と表示して、そのまま編集できます）。この端末で先に変更していた場合は、自動では上書きしません。</p>'+
    '<label class="field"><span>アクセスキー</span><input type="password" id="syncKey" placeholder="Cloudflare に登録したアクセスキー（APP_KEY）" autocomplete="off"></label>'+
    '<label class="chk-set">'+
    '<input type="checkbox" id="syncRemember" class="cb">この端末にアクセスキーを保存して次回から入力を省く</label>'+
    '<p class="note note-tight">保存すると、アクセスキーは暗号化してこのブラウザの中に残ります。共用の端末では保存しないでください。</p>'+
    '<p id="syncSecretNote" class="note-m c-red secret-note"></p>'+
    '<div class="row"></div><p id="syncStatus" class="mt-8"></p></div>');
  var g=function(id){ return s5.querySelector("#"+id); };
  // 同期が働いていない理由を、節の先頭に出す
  var why=!store.get("cf-key") ? ["未入力","アクセスキーがまだ入っていません。下の欄に入れると、保存してある締切を読み込めます。"]
    : _cfAuthStopped ? ["停止中","アクセスキーが違うため、自動の読み込み・同期を止めています。正しいキーを入れ直してください。"] : null;
  if(why) s5.querySelector("h3").after(h('<p class="sync-warn"><span class="badge"><i>●</i> '+why[0]+'</span>'+why[1]+'</p>'));
  g("syncRemember").checked=!!store.get("cf-key");
  secretGet("cf-key").then(function(t){ // 暗号化して保存してあるので、復号できてから入れる（入力し始めていたら上書きしない）
    if(t && !g("syncKey").value) g("syncKey").value=t;
    if(!t && !store.get("cf-key")) g("syncRemember").checked=false;
  });
  // 最後に同期した時刻。間が空いていると赤字にして気づけるようにする
  var ls=lastSyncText();
  var lsEl=h('<p class="sync-last'+(ls&&ls.stale?' c-red':'')+'">'+
    (ls?('最終'+escHtml(ls.kind)+'：<b>'+escHtml(ls.rel)+'</b>　<span class="c-ink3">'+escHtml(ls.text)+'</span>'
         +(ls.stale?'<br>しばらく同期されていません。登録した内容が毎朝の連絡に反映されていない可能性があります。':''))
        :'まだ一度も同期していません。')+'</p>');
  s5.insertBefore(lsEl, s5.querySelector(".field"));
  var cs=conflictStats();
  if(cs.total) lsEl.after(h('<p class="note">他の端末の更新とぶつかった回数：'+cs.total+'回（うち上書き '+cs.overwrote+'回、失われた可能性のある締切 '+cs.lost+'件）</p>'));
  if(_lastAutoSyncError) lsEl.after(h('<p class="c-red">最後の自動同期は失敗しました：'+escHtml(_lastAutoSyncError.reason)+'</p>'));
  // この端末の締切が0件なら、先にすることは読み込み（別の端末で初めて設定したときの上書き事故を防ぐ）
  var emptyHere=!db.items.length;
  var bSync=h('<button class="btn'+(emptyHere?'':' fill')+'">Cloudflareに同期する</button>');
  bSync.onclick=function(){ syncToCloud(g,s5); };
  var bPull=h('<button class="btn'+(emptyHere?' fill':'')+'">Cloudflareから読み込む</button>');
  bPull.onclick=function(){ pullFromCloud(g,s5); };
  s5.querySelector(".row").append(bSync,bPull);
  put("sync",s5);
  // まだ何も無い端末なら、アクセスキーを入れた時点で自動で読み込む（ボタンを押さなくてよい）。
  // 締切がある端末や、同期したことがある端末では、取り違えを防ぐため自動では読み込まない（ボタンで確認つきで読み込む）
  var _keyPulled="";
  var autoPullOnKey=function(){
    var k=g("syncKey").value.trim();
    if(k.length<24 || k===_keyPulled) return; // 入力の途中や、同じキーでの重複は何もしない
    if(db.items.length || store.get("gh-known-updatedAt")) return;
    _keyPulled=k;
    pullFromCloud(g,s5);
  };
  g("syncKey").addEventListener("change",autoPullOnKey);
  g("syncKey").addEventListener("paste",function(){ setTimeout(autoPullOnKey,0); });

  // Discordへ今すぐ送る
  var s6=h('<div class="sec"><h3>Discordへ今すぐ送る</h3>'+
    '<p>毎朝の連絡を待たずに、今の締切一覧をDiscordへ送ります。通知先は、Cloudflare に登録したWebhookです。</p>'+
    '<div class="row"></div><p id="dcStatus" class="mt-8"></p></div>');
  var bSend=h('<button class="btn fill">今すぐ送信</button>');
  bSend.onclick=function(){ sendToDiscord(s6,s5); };
  s6.querySelector(".row").appendChild(bSend);
  put("notify",s6);

  // 登録時の自動処理
  var s7=h('<div class="sec"><h3>登録したときの自動処理</h3>'+
    '<p>締切を登録・編集したときに、以下を自動で行います。上の設定が済んでいない場合は何も起きません。</p></div>');
  var wrap=h('<label class="chk-auto">'+
    '<input type="checkbox" class="cb cb-top">'+
    '<span>Cloudflareへ自動で同期する<br><span class="note">同期ボタンを押し忘れても、翌朝のDiscord通知に反映されます</span></span></label>');
  var cb=wrap.querySelector("input");
  cb.checked=!!db.settings.autoSync;
  cb.onchange=function(){
    db.settings.autoSync=cb.checked; saveRaw(); // 設定は同期対象外なのでupdatedAtは進めない
    toast(cb.checked?"有効にしました":"無効にしました");
  };
  s7.appendChild(wrap);
  put("notify",s7);
  }

  put("notify",h('<div class="sec"><h3>通知のしくみ</h3><p>このアプリ自体は通知を出しません。「カレンダーへ」で書き出した .ics を iPhone で開くと、標準カレンダーに予定と通知（1週間前・前日・当日）が登録され、アプリを閉じていても通知が届きます。締切の日時を変更したときは、もう一度書き出して取り込み直してください（同じ予定が上書きされます）。</p>'+
    '<p><b>iPhoneで取り込むときの注意：</b>Discordなどの添付ファイルを直接タップすると「照会カレンダー」として登録され、更新がすぐ反映されません。長押しして「ファイルに保存」してから開き、「カレンダーに追加」を選んでください。このアプリの「カレンダーへ」ボタンから書き出したファイルは、その心配がありません。</p></div>'));
  if(CF===true) put("notify", feedUrlSection());
  if(CF===true) put("notify", notifyLogSection());
  settingsAssemble(groups);

}

/* ========== 保存先の判定（Cloudflare の Worker） ==========
   このアプリが Worker から配信されているとき（同じ場所に /api/health がある）は、締切データを Worker に保存する。
   ほかの場所（ファイルを直接開いたときなど）では、同期はできず、端末の中のデータだけで使う。
   判定は起動時に1回。通信できなかったときは、前回の判定を使う（オフラインでも保存先が変わらないように） */
var CF=store.get("sync-backend")==="cf" ? true : null, _cfProbe=null, _cfKeyHinted=false;
function cfDetect(){
  if(_cfProbe) return _cfProbe;
  if(location.protocol==="file:"){ CF=false; return (_cfProbe=Promise.resolve(false)); }
  _cfProbe=fetch(location.origin+"/api/health",{cache:"no-store"})
    .then(function(res){ return res.ok ? res.json() : null; })
    .then(function(j){
      CF=!!(j&&j.ok===true);
      store.set("sync-backend", CF?"cf":"");
      if(CF && !_cfKeyHinted){
        _cfKeyHinted=true;
        secretGet("cf-key").then(function(k){ if(!k){ toast("一覧の上の案内から、アクセスキーを入れてください"); softRender(); } });
      }
      return CF;
    })
    .catch(function(){ _cfProbe=null; return CF===true; }); // 通信できないときは決めつけず、前回の判定のまま
  return _cfProbe;
}
/* 保存先の名前（画面の文言用） */
function RN(){ return "Cloudflare"; }

function cfConfigFor(key){
  return {kind:"cf", api:location.origin+"/api/data", headers:{"Authorization":"Bearer "+key}};
}
function getStoredCfConfig(){
  return secretGet("cf-key").then(function(key){ return key ? cfConfigFor(key) : null; });
}
/* Worker の /api/data を読む。{rev, data}。データがまだ無ければ rev 0・data null */
function cfFetchData(cfg){
  return fetch(cfg.api+"?_="+Date.now(),{headers:cfg.headers, cache:"no-store"})
    .then(function(res){
      if(!res.ok) return res.json().catch(function(){ return {}; }).then(function(e){
        var err=new Error(e.error||e.message||("HTTP "+res.status));
        err.status=res.status; // 401・429 を自動処理が見分けるため
        throw err;
      });
      return res.json();
    });
}
/* 認証の失敗(401)を受けたら、ページを開き直すか、設定でアクセスキーを入れ直すまで、自動の通信をしない。
   古いキーの端末が自動通信で失敗を重ねると、同じ回線の正しい端末まで Worker に止められる(10分に10回)ため。
   429(すでに止められている)のときは、理由を一度だけ知らせる */
var _cfAuthStopped=false, _cfLimitShown=false;
function cfAutoBlocked(cfg){ return cfg.kind==="cf" && _cfAuthStopped; }
function cfNoteAuthFailure(err){
  var st=err && err.status;
  if(st===401){
    if(_cfAuthStopped) return;
    _cfAuthStopped=true;
    toast("アクセスキーが違うため、自動の読み込み・同期を止めました。設定（右上のメニュー（☰））で入れ直してください");
  } else if(st===429 && !_cfLimitShown){
    _cfLimitShown=true;
    toast("認証の失敗が続いたため、しばらく使えません。10分ほど待ってください");
  }
}
/* 初めての端末（アクセスキー未入力）か、キーが違うと分かった端末では、一覧の先頭に案内のカードを出す。
   設定画面へ移らずに、その場でキーを入れて読み込めるようにする */
var _cfKeyOk=false; // このページを開いてから、キーで読み込めたか（暗号化して保存できない端末でも、カードを消すため）
function needsKeyCard(cf, hasKey, authStopped, keyOk){
  return cf===true && !keyOk && (!hasKey || authStopped);
}
function keyCard(){
  var wrong=_cfAuthStopped && !!store.get("cf-key");
  var el=h('<div class="keycard" role="group" aria-labelledby="keycardTitle">'+
    '<div class="keycard-head"><span class="badge"><i>◇</i> '+(wrong?"キー違い":"未同期")+'</span>'+
    '<b id="keycardTitle">'+(wrong?"アクセスキーが違うようです":"この端末はまだ同期していません")+'</b></div>'+
    '<p>'+(wrong?"保存してあるアクセスキーでは読み込めませんでした。正しいキーを入れ直してください。":"アクセスキーを入れると、保存してある締切を読み込みます。")+'</p>'+
    '<div class="keycard-row quick"><input type="password" id="keycardIn" autocomplete="off" placeholder="アクセスキー（APP_KEY）" aria-label="アクセスキー">'+
    '<button type="button">読み込む</button></div>'+
    '<p class="keycard-msg" id="keycardMsg" role="status"></p></div>');
  var input=el.querySelector("input"), btn=el.querySelector("button"), msg=el.querySelector("#keycardMsg");
  function go(){
    var key=input.value.trim();
    if(!key){ msg.textContent="アクセスキーを入力してください。"; return; }
    btn.disabled=true; msg.textContent="確認しています…";
    var cfg=cfConfigFor(key);
    cfFetchData(cfg).then(function(){
      // キーが合うと分かってから保存する（間違ったキーを残して、自動の通信を失敗させないため）
      _cfAuthStopped=false; _cfLimitShown=false; _cfKeyOk=true;
      return secretSet("cf-key", key).then(function(){ return proceedPull(cfg,msg); }).then(function(){ btn.disabled=false; });
    }).catch(function(err){
      var st=err&&err.status;
      msg.textContent=st===401 ? "アクセスキーが違います。" : st===429 ? "認証の失敗が続いたため、しばらく使えません。10分ほど待ってください。" : "読み込めませんでした："+(err&&err.message||"");
      btn.disabled=false;
    });
  }
  btn.onclick=go;
  input.onkeydown=function(e){ if(e.key==="Enter"){ e.preventDefault(); go(); } };
  return el;
}
/* 最後に確認した保存先の版（rev）。読み込みに成功したとき・送信に成功したときに保存する。
   「他の端末の更新があるか」は、端末の時計（updatedAt）ではなく、Worker が数える rev で判断する
   （端末の時計がずれていても、古い状態から上書きしてしまわないため） */
var CF_REV_KEY="cf-known-rev";
function cfKnownRev(){ var v=store.get(CF_REV_KEY); return v ? String(v) : null; }
function cfSaveRev(rev){ if(typeof rev==="number" && rev>=0) store.set(CF_REV_KEY, String(rev)); }
/* 保存先の版（sha の代わりに rev）と更新時刻。まだ無ければ sha:null */
function cfFetchState(cfg){
  return cfFetchData(cfg).then(function(j){
    var d=j.data;
    return {cf:true, sha:j.rev>0?String(j.rev):null, updatedAt:(d&&d.updatedAt)||null, itemCount:(d&&Array.isArray(d.items))?d.items.length:0};
  });
}
/* 保存する。If-Match には、最後に確認した版（cf-known-rev）を付け、違っていれば 409（自動では再送しない）。
   承知の上で上書きするときだけ、cfg.ifMatch に確認した版を入れる。上書き前の内容を必ず残したいときは cfg.backup=true（?backup=1）。
   成功したら、応答の rev を「最後に確認した版」として保存する */
function cfPut(cfg,payload){
  var q=cfg.backup?"?backup=1":"";
  var ifMatch=(cfg.ifMatch!==undefined && cfg.ifMatch!==null) ? String(cfg.ifMatch) : (cfKnownRev()||"0");
  cfg.backup=false; cfg.ifMatch=null;
  return fetch(cfg.api+q,{method:"PUT",
    headers:Object.assign({"Content-Type":"application/json","If-Match":ifMatch},cfg.headers),
    body:JSON.stringify(payload)})
    .then(function(res){
      if(!res.ok) return res;
      return res.clone().json().then(function(j){ cfSaveRev(j&&j.rev); return res; }, function(){ return res; });
    });
}
/* ---- 世代バックアップ（Cloudflare）。設定の「バックアップと復元」から、一覧・中身の確認・復元をする ---- */
function cfSnapUrl(cfg,id){ return cfg.api.replace(/\/data$/,"/snapshots")+(id===undefined?"":"/"+encodeURIComponent(id)); }
function cfGetJson(cfg,url){
  return fetch(url,{headers:cfg.headers, cache:"no-store"}).then(function(res){
    if(!res.ok) return res.json().catch(function(){ return {}; }).then(function(e){
      var err=new Error(e.error||e.message||("HTTP "+res.status));
      err.status=res.status;
      throw err;
    });
    return res.json();
  });
}
/* 一覧。[{id, at(保存した時刻。epoch秒), rev, size(バイト)}]を新しい順に */
function cfFetchSnapshots(cfg){
  return cfGetJson(cfg,cfSnapUrl(cfg)).then(function(j){ return Array.isArray(j.snapshots) ? j.snapshots : []; });
}
/* 1件の中身。{id, at, rev, data} */
function cfReadSnapshot(cfg,id){
  return cfGetJson(cfg,cfSnapUrl(cfg,id)).then(function(j){
    if(!j || !j.data || !Array.isArray(j.data.items)) throw new Error("この世代バックアップの形式が読み取れません");
    return j;
  });
}
/* 保存した時刻（epoch秒）を、日本時間の「2026/10/29 22:24」に */
function fmtSnapAt(sec){
  var d=new Date(sec*1000+9*3600*1000), p2=function(n){ return ("0"+n).slice(-2); };
  return d.getUTCFullYear()+"/"+(d.getUTCMonth()+1)+"/"+d.getUTCDate()+" "+p2(d.getUTCHours())+":"+p2(d.getUTCMinutes());
}
/* 世代バックアップの内容(snap=cfReadSnapshotのdata)に戻す。
   先に Cloudflare の今の内容を世代バックアップに残してから(?backup=1)置き換え、成功したらこの端末のデータも置き換える。
   失敗したら例外にして、この端末のデータは変えない。使った世代バックアップは消えない */
function cfRestoreSnapshot(cfg,snap){
  var check=sanitizeIncomingItems(snap.items);
  var payload=Object.assign({}, snap, {items:check.kept, updatedAt:new Date().toISOString()});
  return cfFetchData(cfg).then(function(cur){
    cfg.ifMatch=String(cur.rev); // 今の版を確かめたうえで置き換える（同時に他の端末が更新していたら 409）
    cfg.backup=true;             // 今の内容を、間隔に関わらず必ず世代バックアップに残す
    return cfPut(cfg,payload);
  }).then(function(res){
    if(res.ok) return res;
    return res.json().catch(function(){ return {}; }).then(function(e){
      var err=new Error(res.status===409 ? "ほかの端末が同時に更新しました。もう一度試してください" : (e.error||e.message||("HTTP "+res.status)));
      err.status=res.status;
      throw err;
    });
  }).then(function(){
    db.items=check.kept;
    if(check.quarantined.length) db.quarantine=db.quarantine.concat(check.quarantined);
    var meta=sanitizeIncomingMeta(payload);
    if(meta.templates) db.templates=meta.templates;
    if(Array.isArray(payload.trash)) db.trash=normalizeTrash(payload.trash);
    if(meta.categories) db.categories=meta.categories;
    if(payload.catReminders) db.catReminders=cleanCatReminders(payload.catReminders);
    if(payload.catColors) db.catColors=cleanCatColors(payload.catColors);
    if(payload.catIcons) db.catIcons=cleanCatIcons(payload.catIcons);
    if(payload.wcExcluded) db.wcExcluded=WC.wcCleanExcluded(payload.wcExcluded);
    adoptCompletions(payload);
    db.updatedAt=payload.updatedAt;
    saveRaw();
    markSynced("復元");
    markPulled();
    store.set("gh-known-updatedAt", db.updatedAt); // 保存先もこの時刻の内容と一致した（版は cfPut が保存した）
    markClean();
    return {n:check.kept.length, quarantined:check.quarantined.length};
  });
}
/* 上書きすると失われる内容。保存先にあって、この端末に無い（＝消える）もの、両方にあるが保存先のほうが新しい（＝この端末の内容で置き換わる）もの。
   新しさは各締切の seq（編集のたびに増える）で見る。端末の時計は使わない */
function overwriteLosses(localItems, remoteItems){
  var local={}, gone=[], older=[];
  (Array.isArray(localItems)?localItems:[]).forEach(function(it){ if(it && it.id!==undefined) local[it.id]=it; });
  (Array.isArray(remoteItems)?remoteItems:[]).forEach(function(r){
    if(!r || r.id===undefined) return;
    var l=local[r.id], t=String(r.title||"（題名なし）");
    if(!l) gone.push(t);
    else if((r.seq||0)>(l.seq||0)) older.push(t);
  });
  return {gone:gone, older:older};
}
/* 上書きの記録。回数と選んだ道を端末の中にだけ残す（「どれくらい競合するか」を、あとで設定画面から見られるように） */
var CONFLICT_KEY="conflict-log";
function conflictLog(){
  try{ var a=JSON.parse(store.get(CONFLICT_KEY)||"[]"); return Array.isArray(a)?a:[]; }catch(e){ return []; }
}
function noteConflict(choice, losses){
  var a=conflictLog();
  a.push({at:new Date().toISOString(), choice:choice, gone:losses?losses.gone.length:0, older:losses?losses.older.length:0});
  store.set(CONFLICT_KEY, JSON.stringify(a.slice(-50)));
}
function conflictStats(){
  var a=conflictLog();
  return {total:a.length, overwrote:a.filter(function(x){ return x.choice==="overwrite"; }).length, lost:a.reduce(function(n,x){ return n+(x.choice==="overwrite"?(x.gone||0)+(x.older||0):0); },0)};
}
/* 失われる内容を見せて選ばせる画面。true=この端末の内容で上書き、false=保存先の内容を読み込む。
   外側（背景の押下・Esc）で閉じたときは false（上書きしない側）にする */
function askOverwriteDialog(losses){
  return new Promise(function(resolve){
    var list=function(title, arr){
      if(!arr.length) return "";
      return '<p class="ov-h">'+title+'（'+arr.length+'件）</p><ul class="ov-list">'+
        arr.slice(0,5).map(function(t){ return '<li>'+escHtml(t)+'</li>'; }).join("")+
        (arr.length>5?'<li class="ov-more">ほか '+(arr.length-5)+'件</li>':"")+'</ul>';
    };
    var body=losses ? (list("上書きすると消える締切",losses.gone)+list("上書きすると、この端末の内容に置き換わる締切",losses.older)) : "";
    if(losses && !losses.gone.length && !losses.older.length) body='<p class="ov-h">失われる締切は見つかりませんでした（並びや設定の違いのみ）。</p>';
    if(!losses) body='<p class="ov-h">失われる内容を調べられませんでした。</p>';
    var el=h('<dialog class="ov-dlg"><form method="dialog" class="dlg-in">'+
      '<h2>他の端末の更新があります</h2>'+
      '<p>保存先に、この端末がまだ読み込んでいない新しい内容があります。上書きする前の内容は、世代バックアップに保存します。</p>'+
      body+
      '<div class="dlg-acts"><button class="btn" value="overwrite" type="submit">この端末の内容で上書きする</button>'+
      '<button class="btn fill" value="pull" type="submit" autofocus>保存先の内容を読み込む（おすすめ）</button></div>'+
      '</form></dialog>');
    el.addEventListener("close",function(){ var ok=el.returnValue==="overwrite"; el.remove(); resolve(ok); });
    document.body.appendChild(el);
    el.showModal();
  });
}
/* Cloudflare に、この端末がまだ読み込んでいない更新があるとき、失われる内容を見せて選ばせる。
   true=バックアップ付きで上書き、false=上書きせず読み込みの手順へ */
function cfAskOverwrite(cfg){
  return cfFetchData(cfg).then(function(j){
    return overwriteLosses(db.items, j&&j.data&&j.data.items);
  }, function(){ return null; }).then(function(losses){
    return askOverwriteDialog(losses).then(function(ok){
      noteConflict(ok?"overwrite":"pull", losses);
      return ok;
    });
  });
}

/* 設定画面を開いていなくても使える、保存済みの同期設定（アクセスキー）の読み取り。
   アクセスキーを保存していない端末では、自動の取り込み・同期は動かない（安全側） */
function getStoredSyncConfig(){
  return cfDetect().then(function(cf){ return cf ? getStoredCfConfig() : null; });
}

/* この端末のデータが「前回Cloudflareと一致していた状態から何も変わっていない」ときだけ、
   Cloudflare上の新しい内容を自動で取り込む。
   ローカルにまだ送っていない変更がある場合は、データを失わないよう自動では上書きしない */
var _staleNoticeShown=false;
function autoPullIfStale(){
  // 同期の設定自体が無ければ何もしない
  // 結果: true=保存先を読めた、false=読めなかった（圏外など）、undefined=同期の設定が無い
  return getStoredSyncConfig().then(function(cfg){ return cfg ? autoPullWith(cfg) : undefined; }).catch(function(){ return false; });
}
function autoPullWith(cfg){
  if(cfAutoBlocked(cfg)) return Promise.resolve();
  // ネットワーク不調などは静かに諦める（自動処理のため）。認証の失敗だけは cfNoteAuthFailure が一度だけ知らせる
  var cfRev=null; // Cloudflare から読んだ版
  var read=false; // 保存先を読めたか（読めなかったときは、画面に「前回の内容」と出す）
  return cfFetchData(cfg).then(function(j){ cfRev=j.rev; read=true; return j.data; }).catch(function(e){ cfNoteAuthFailure(e); return null; })
    .then(function(d){
      // 比較に必要な情報（件数・時刻）が無いデータは判断できないので何もしない
      if(!d || !Array.isArray(d.items) || !d.updatedAt) return;

      var known=store.get("gh-known-updatedAt"); // 前回、保存先と一致していた時点の時刻
      var localAt=db.updatedAt;
      if(!known || !localAt) return; // 一度も同期していない端末は対象外（必ず手動の一回目を経由させる）

      var knownRev=cfKnownRev();                // 版（rev）で比べる（他の端末の時計に左右されない）
      if(!knownRev) return;                     // 版を一度も確認していない端末は、必ず手動の読み込み・同期を経由させる
      var remoteChanged=(String(cfRev)!==knownRev); // 前回同期時点から保存先が変わったか
      var localChanged=hasUnsyncedChanges();    // この端末に、人の操作による未送信の変更があるか（機械の自動完了は数えない）
      if(!remoteChanged) return;                // 保存先に新しい内容が無ければ何もしない

      if(!localChanged){
        // ローカルは前回同期時点のまま変更されていない → 安全に取り込める
        var check=sanitizeIncomingItems(d.items);
        db.items=check.kept;
        if(check.quarantined.length) db.quarantine=db.quarantine.concat(check.quarantined);
        var meta=sanitizeIncomingMeta(d);
        if(meta.templates) db.templates=meta.templates;
        if(Array.isArray(d.trash)) db.trash=normalizeTrash(d.trash);
        if(meta.categories) db.categories=meta.categories;
        if(d.catReminders) db.catReminders=cleanCatReminders(d.catReminders);
        if(d.catColors) db.catColors=cleanCatColors(d.catColors);
        if(d.catIcons) db.catIcons=cleanCatIcons(d.catIcons);
        if(d.wcExcluded) db.wcExcluded=WC.wcCleanExcluded(d.wcExcluded);
        adoptCompletions(d);
        db.updatedAt=d.updatedAt;
        saveRaw(); softRender();
        markPulled();
        markSynced("自動反映");
        store.set("gh-known-updatedAt", d.updatedAt);
        markClean();
        cfSaveRev(cfRev);
        toast("他の端末で更新された内容を自動で反映しました"+(check.quarantined.length?"（"+check.quarantined.length+"件は隔離）":""));
        if(autoCompleteOverdueItems()>0) softRender(); // 取り込んだ内容に、期限切れの自動完了をもう一度かける（どの端末でも同じ結果になる）
      } else if(!_staleNoticeShown){
        // 双方が前回同期後に変更されている（競合）→ 自動上書きはしない。一度だけ知らせる
        _staleNoticeShown=true;
        toast("Cloudflareに新しい内容がありますが、この端末の未同期の変更を守るため自動反映していません");
      }
    })
    .catch(function(){})
    .then(function(){ return read; });
}

/* Cloudflare 向けの設定（アクセスキーだけ）。画面から読み取り、保存する指定ならこの端末に暗号化して残す */
function cfConfigFromUI(g,statusEl){
  var key=g("syncKey").value.trim();
  if(!key){ statusEl.textContent="アクセスキーを入力してください。"; return null; }
  _cfAuthStopped=false; _cfLimitShown=false; // キーを入れ直したので、自動の通信を再開する
  if(g("syncRemember").checked){
    secretSet("cf-key", key).then(function(ok){
      g("syncSecretNote").textContent=ok?"":"この端末では暗号化して保存できないため、アクセスキーは保存しませんでした（今回の操作だけに使います）。";
    });
  } else { secretDel("cf-key"); g("syncSecretNote").textContent=""; }
  return cfConfigFor(key);
}

/* エラー内容から、次にどうすればよいかを添える */
function syncHint(m){
  if(/アクセスキー/.test(m)) return "設定のアクセスキーが正しいか確認してください。";
  if(/しばらく使えません/.test(m)) return "10分ほど待ってから、もう一度お試しください。";
  if(/他の端末の更新があります/.test(m)) return "「読み込む」で他の端末の内容を取り込んでから、同期してください。";
  return "";
}

/* Worker から、Worker に登録した Webhook へ今の締切一覧を送る（毎朝の通知と同じ文面）。アクセスキーは同期の欄から読む */
function sendToDiscord(s6,s5){
  var statusEl=s6.querySelector("#dcStatus");
  var g=function(id){ return s5.querySelector("#"+id); };
  var cfg=cfConfigFromUI(g,statusEl);
  if(!cfg) return;
  statusEl.textContent="Cloudflareから送信しています…";
  fetch(location.origin+"/api/digest",{method:"POST", headers:cfg.headers})
    .then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(j){
        if(res.ok && j.ok){ statusEl.textContent="送信しました（"+j.sent+"通）。"; toast("Discordへ送信しました"); return; }
        var m=j.error||("HTTP "+res.status), hint=syncHint(m);
        statusEl.textContent="送信に失敗しました："+m+(hint?"　→ "+hint:"");
      });
    })
    .catch(function(){ statusEl.textContent="送信に失敗しました。通信状況を確認してください。"; });
}

/* カテゴリの並び順を1つ入れ替える */
function moveCategory(idx, dir){
  var to=idx+dir;
  if(to<0||to>=db.categories.length) return;
  var arr=db.categories;
  var tmp=arr[idx]; arr[idx]=arr[to]; arr[to]=tmp;
  save(); render(); scheduleAutoSync(); // 並び順で自動の色が決まるので、他の端末にも送る
}

/* Cloudflare のデータを読み込んで、この端末のデータを置き換える */
function pullFromCloud(g,s5){
  var statusEl=s5.querySelector("#syncStatus");
  var cfg=cfConfigFromUI(g,statusEl);
  if(!cfg) return;
  proceedPull(cfg,statusEl);
}

/* 保存先のデータ本文（JSONの文字列）を読む。まだ無ければ理由つきのエラー */
function getRemoteText(cfg){
  return cfFetchData(cfg).then(function(j){
    cfg.rev=j.rev; // 読んだ版。読み込みに成功したら「最後に確認した版」として保存する
    if(!j.data) throw new Error("Cloudflare にデータがまだありません。先に移行（取り込み）を済ませるか、別の端末で「同期する」を実行してください。");
    return JSON.stringify(j.data);
  });
}

function proceedPull(cfg,statusEl){
  statusEl.textContent="読み込んでいます…";
  return getRemoteText(cfg)
    .then(function(text){
      var d=JSON.parse(text);
      if(!d||!Array.isArray(d.items)) throw new Error("データの形式が読み取れません。");
      var check=sanitizeIncomingItems(d.items);
      var n=check.kept.length;
      if(db.items.length && !confirm("この端末の締切"+db.items.length+"件を、"+RN()+"上の"+n+"件で置き換えます。よろしいですか？")){
        statusEl.textContent="読み込みを中止しました。";
        return;
      }
      db.items=check.kept;
      if(check.quarantined.length){
        db.quarantine=db.quarantine.concat(check.quarantined);
      }
      var meta=sanitizeIncomingMeta(d);
      if(meta.templates) db.templates=meta.templates;
      if(Array.isArray(d.trash)) db.trash=normalizeTrash(d.trash);
      if(meta.categories) db.categories=meta.categories;
      if(d.catReminders) db.catReminders=cleanCatReminders(d.catReminders);
        if(d.catColors) db.catColors=cleanCatColors(d.catColors);
        if(d.catIcons) db.catIcons=cleanCatIcons(d.catIcons);
        if(d.wcExcluded) db.wcExcluded=WC.wcCleanExcluded(d.wcExcluded);
      adoptCompletions(d);
      // 取り込んだ内容の時刻をそのまま引き継ぐ（今の時刻で上書きすると比較の基準が壊れるため）
      db.updatedAt=d.updatedAt||new Date().toISOString();
      saveRaw(); render();
      markSynced("読み込み");
      markPulled();
      _autoSyncFailShown=""; _lastAutoSyncError=null; // 読み込めたので、自動同期の失敗の表示は消す
      store.set("gh-known-updatedAt", db.updatedAt); // 保存先もこの時刻の内容と一致した
      markClean();
      cfSaveRev(cfg.rev);
      statusEl.textContent="読み込みました（"+n+"件）。"+(check.quarantined.length?(" "+check.quarantined.length+"件は形式が不正のため隔離しました（設定で確認できます）。"):"");
      toast(RN()+"から"+n+"件を読み込みました"+(check.quarantined.length?"（"+check.quarantined.length+"件は隔離）":""));
    })
    .catch(function(err){
      var m=err.message||"";
      var hint=syncHint(m);
      statusEl.textContent="読み込みに失敗しました："+m+(hint?"　→ "+hint:"");
    });
}

function syncToCloud(g,s5){
  var statusEl=s5.querySelector("#syncStatus");
  var cfg=cfConfigFromUI(g,statusEl);
  if(!cfg) return;
  proceedSync(cfg,statusEl);
}

function proceedSync(cfg,statusEl){
  // この端末の締切が0件（別の端末で初めて設定した直後など）のまま送ると、Cloudflare 上のデータが空で上書きされてしまう。
  // 保存先に中身があるときは、送らずに読み込む。無いとき（初回）は従来どおり送る
  if(db.items.length) return proceedSyncChecked(cfg,statusEl);
  statusEl.textContent="Cloudflare上の内容を確認しています…";
  cfFetchState(cfg).then(function(r){
    if(r.itemCount>0){
      toast("この端末の締切は0件のため、上書きせずCloudflareから読み込みます");
      proceedPull(cfg,statusEl);
    } else {
      proceedSyncChecked(cfg,statusEl);
    }
  }, function(){ proceedSyncChecked(cfg,statusEl); }); // 確認できなくても、この先の同期処理が同じ通信で失敗を知らせる
}
function proceedSyncChecked(cfg,statusEl){
  // この端末がCloudflare上のデータを24時間以上取得していない場合、
  // 他の端末で更新された内容を上書きしてしまう恐れがあるので確認を挟む
  var hours=hoursSincePulled();
  if(hours!==null && hours>=24){
    var days=Math.floor(hours/24);
    var ok=confirm(
      "この端末が最後にCloudflareの内容を取得してから "+days+"日以上 経っています。\n\n"+
      "他の端末で登録・更新した内容があると、今の同期でそれが上書きされて消える可能性があります。\n\n"+
      "続ける前に、今Cloudflare上にある内容を世代バックアップに残します。よろしいですか？"
    );
    if(!ok){ statusEl.textContent="同期を中止しました。心配な場合は先に「Cloudflareから読み込む」をお試しください。"; return; }
    statusEl.textContent="安全のため、現在の内容をバックアップしています…";
    backupRemoteBeforeOverwrite(cfg).then(function(){ doSync(cfg,statusEl,true); });
    return;
  }
  doSync(cfg,statusEl,false);
}

/* 上書きされてしまう前に、今の内容を世代バックアップに残すよう印を付ける */
function backupRemoteBeforeOverwrite(cfg){
  // Cloudflare は、保存するたびに上書き前の内容を世代バックアップに残す（次の保存で必ず残すよう印を付ける）
  cfg.backup=true;
  return Promise.resolve();
}

function doSync(cfg,statusEl,backedUp){
  statusEl.textContent="同期しています…";
  // 一度も保存していない端末はupdatedAtが無いので、送る直前に確定させる
  if(!db.updatedAt) db.updatedAt=new Date().toISOString();
  var pushedAt=db.updatedAt; // 送信中の編集に影響されないよう、送った時点の値を捕捉
  var mark=_editSeq;
  var payload=syncPayload(); // 自動同期と同じ内容を送る
  // 送る内容を作った時点の版。確認と送信の間に自動の取り込みで版が進んでも、この版で送る（新しい版を古い内容で上書きしない）
  var baseRev=cfKnownRev();

  function put(){
    if(cfg.ifMatch===undefined||cfg.ifMatch===null) cfg.ifMatch=baseRev||"0"; // 上書きを承知したときは、確認した版（cfg.ifMatch）を優先する
    return cfPut(cfg,payload);
  }

  // Cloudflare 上に、この端末が取り込んでいない他の端末の更新がある場合は、上書き前に確認する
  // （24時間以内に取得していても、その後に別の端末が同期していれば消えてしまうため）
  cfFetchState(cfg)
    .then(function(r){
      if(backedUp || !remoteHasUnknownChanges(r)) return;
      return cfAskOverwrite(cfg).then(function(ok){
        if(!ok) throw new Error("__sync_to_pull__"); // 上書きしない → 読み込みの手順へ
        cfg.backup=true; cfg.ifMatch=r.sha; // 承知の上で上書きする。対象は、いま確認した版
      });
    })
    .then(put)
    .then(function(res){
      if(res.status===409){
        // 新しい版で自動的に送り直さない（他の端末の更新を消してしまうため）。利用者に選ばせる
        return cfFetchState(cfg).then(function(r){
          return cfAskOverwrite(cfg).then(function(ok){
            if(!ok) throw new Error("__sync_to_pull__");
            cfg.backup=true; cfg.ifMatch=r.sha||"0";
            return put();
          });
        });
      }
      return res;
    })
    .then(function(res){
      if(!res.ok) return res.json().then(function(e){ throw new Error(e.message||e.error||("HTTP "+res.status)); });
      markSynced("同期");
      markPulled(); // 自分が今アップロードした内容＝この端末の最新状態、として扱う
      _autoSyncFailShown=""; _lastAutoSyncError=null; // 手動の同期が通ったので、自動同期の失敗の表示は消す
      store.set("gh-known-updatedAt", pushedAt); // 保存先もこの時刻の内容と一致した
      markClean(mark);
      statusEl.textContent="同期しました。次の朝のダイジェストから反映されます。";
      toast("Cloudflareに同期しました");
    })
    .catch(function(err){
      var m=err.message||"";
      if(m==="__sync_to_pull__"){ statusEl.textContent="上書きせず、読み込みに進みます。"; proceedPull(cfg,statusEl); return; }
      var hint=syncHint(m);
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
  setTimeout(runDeferredRefresh,0); // 開いている間に保留した、保存先の取り込みを行う
});
function openDialog(item){
  editingId=item?item.id:null;
  editingSeq=item?(item.seq||0):0; // 開いた時点の版。保存の前に、他の端末や自動処理で変わっていないか確かめる
  document.getElementById("dlgTitle").textContent=item?"締切を編集":"締切を登録";
  // 新しく登録するときの保存は、専用の音（登録）が鳴るので共通の音を重ねない。編集の保存には専用の音が無いので、共通の音のまま
  var dlgSave=dlgForm.querySelector('button[value="save"]');
  if(item) dlgSave.removeAttribute("data-sfx"); else dlgSave.setAttribute("data-sfx","own");
  var catSel=document.getElementById("fCat");
  catSel.innerHTML="";
  db.categories.forEach(function(c){ var o=document.createElement("option"); o.value=c; o.textContent=c; catSel.appendChild(o); });

  // テンプレート欄は新規登録のときだけ出す（編集中に入れ替わると混乱するため）
  var tplRow=document.getElementById("tplRow"), tplSel=document.getElementById("fTpl");
  if(!item && db.templates.length){
    tplRow.hidden=false;
    tplSel.innerHTML="";
    var none=document.createElement("option"); none.value=""; none.textContent="（使わない）"; tplSel.appendChild(none);
    db.templates.forEach(function(t){
      var o=document.createElement("option"); o.value=t.id; o.textContent=t.name; tplSel.appendChild(o);
    });
    tplSel.value="";
    tplSel.onchange=function(){ applyTemplate(tplSel.value); };
  } else {
    tplRow.hidden=true;
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
  document.getElementById("dlgMore").open=false; // 前回の開閉を引き継がない。設定済みのものがあれば、下の syncDialogRows が開く
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

/* 「詳しい設定」の中に、既定から変えてあるものがあるか（期間・自動完了・この締切だけの色・帯を隠す） */
function dlgMoreActive(){
  return document.getElementById("fSpan").checked || document.getElementById("fAutoComplete").checked || !!dlgColor ||
    (document.getElementById("fRep").value!=="none" && !document.getElementById("fCalShow").checked);
}

/* チェックや選択に応じて、関係のある入力欄だけを出す */
function syncDialogRows(){
  // 「詳しい設定」は閉じておく。ただし、設定済みのものが中にあるときは開いて、見えないまま効いていることがないようにする
  if(dlgMoreActive()) document.getElementById("dlgMore").open=true;
  var span=document.getElementById("fSpan").checked;
  document.getElementById("startRow").hidden=!span;
  document.getElementById("dueLabel").textContent=span?"終了日":"締切日";
  var rep=document.getElementById("fRep").value;
  document.getElementById("repCountRow").hidden=(rep==="none");
  document.getElementById("calShowRow").hidden=(rep==="none");
  // 終日のときは時刻欄を隠す
  var allDay=document.getElementById("fAllDay").checked;
  var dueCell=document.querySelector(".dueTimeCell"), startCell=document.querySelector(".startTimeCell");
  dueCell.style.display=allDay?"none":"";
  startCell.style.display=allDay?"none":"";
  document.getElementById("fTime").required=!allDay;

  // 締切日が土日祝なら知らせる（登録は妨げない）
  var note=document.getElementById("dayOffNote");
  var dv=document.getElementById("fDate").value;
  note.hidden=true;
  if(dv){
    var dd=new Date(dv+"T00:00:00");
    var hol=holidayName(dv);
    if(hol){ note.textContent="⚠️ この日は祝日です（"+hol+"）"; note.hidden=false; }
    else if(dd.getDay()===0){ note.textContent="⚠️ この日は日曜です"; note.hidden=false; }
    else if(dd.getDay()===6){ note.textContent="⚠️ この日は土曜です"; note.hidden=false; }
  }
  updateOverlapNote();
}

/* 入力中の日時と同じ時間帯に他の予定があれば知らせる（登録は妨げない）。
   判定は時刻のある予定どうしだけ。終日・数日にまたがる期間は対象外 */
function updateOverlapNote(){
  var note=document.getElementById("overlapNote");
  note.hidden=true;
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
  note.hidden=false;
}
document.getElementById("fDate").addEventListener("change",syncDialogRows);
["fTime","fStart","fStartTime"].forEach(function(id){ document.getElementById(id).addEventListener("change",updateOverlapNote); });
document.getElementById("fSpan").addEventListener("change",syncDialogRows);
document.getElementById("fAllDay").addEventListener("change",syncDialogRows);
document.getElementById("fRep").addEventListener("change",syncDialogRows);

/* 入力欄で Enter を押したら保存する。何もしないとフォームの既定の送信ボタン（先頭の「やめる」）が使われ、
   入力が捨てられてしまう。メモは Enter で改行し、Ctrl+Enter（Mac は ⌘+Enter）で保存する。
   選択欄・日本語変換の確定中の Enter と、色のカラーコード欄（独自に処理）はそのまま */
dlgForm.addEventListener("keydown",function(e){
  if(e.key!=="Enter" || e.isComposing || e.keyCode===229 || e.defaultPrevented) return;
  var memoSave=e.target.tagName==="TEXTAREA" && (e.ctrlKey || e.metaKey);
  if(!memoSave && (e.target.tagName!=="INPUT" || e.target.type==="color")) return;
  e.preventDefault();
  var saveBtn=dlgForm.querySelector('button[value="save"]');
  if(dlgForm.requestSubmit) dlgForm.requestSubmit(saveBtn); else saveBtn.click();
});

/* 押されたボタンを覚えておく（submitter に対応しない古いブラウザ用）。分からないときは保存しない */
var lastSubmitBtn=null;
dlgForm.addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button"):null;
  lastSubmitBtn=(b&&b.type==="submit"&&b.form===dlgForm)?b:null;
});
/* 編集を始めたときの版（seq）と、いまの版が違うか。違えば、取り込みや自動処理で項目が変わっているので、古い内容で上書きしない */
function editConflict(items, id, seqAtOpen){
  var cur=items.filter(function(i){ return i.id===id; })[0];
  return !!cur && (cur.seq||0)!==(seqAtOpen||0);
}
dlgForm.addEventListener("submit",function(e){
  var btn=e.submitter||lastSubmitBtn; lastSubmitBtn=null;
  if(!btn||btn.value!=="save") return;
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
    if(editConflict(db.items, editingId, editingSeq)){
      e.preventDefault(); // ダイアログは開いたまま（入力内容は残る）。上書きはしない
      toast("この締切は、開いたあとに別の更新で変わりました。いったんやめて開き直し、内容を確かめてから保存してください");
      return;
    }
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
    playSfx(techoStyle()?"pencil":"add"); // 手帳風：鉛筆で書く「カリカリ」
    if(motionOn() && !techoStyle()) playQuestAccept(it);
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
});

function applyCompletion(it, source){
  if(source!=="auto") notePickDone(it); // 済んだ一手を、その日の欄に残すために覚える
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
  // 自動完了の記録の id は、締切の id と、その回の締切日時で決まる値にする（2台で同じ締切を自動完了しても、記録が重複しないように）
  var cid=source==="auto" ? "auto:"+it.id+":"+due.toISOString() : "c"+now.getTime().toString(36)+Math.random().toString(36).slice(2,6);
  var c={id:cid, itemId:it.id, title:it.title,
         cat:it.cat||"その他", due:due.toISOString(), doneAt:now.toISOString(), lead:Math.round(hours*10)/10,
         kind:kind, exp:exp, src:source};
  if(isRepeating(it)) c.rep=true;
  db.completions.push(c);
  trimCompletions();
  return c;
}
function applyCompletionCore(it){
  delete it.pick; // 今日の一手の印は、完了（繰り返しなら次の回へ進む）で外す
  it.done=true; it.doneAt=new Date().toISOString();
  it.seq=(it.seq||0)+1; // 編集中の別の操作（開いたままの編集ダイアログ）と区別できるよう、版を進める
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
/* 毎月・毎年で基準日が29〜31日のとき、無い月は月末に丸める（アプリの nextOccurrence と同じ）ための RRULE の追加分。
   素の FREQ=MONTHLY は31日が無い月を飛ばすので、「基準日」と「月末」の早い方（BYSETPOS=1）を指定する。
   DTSTART は時刻つきなら UTC、終日なら日付で書くため、締切日との日数差 diff を引いて合わせる（build_ics.py と同じ計算） */

/* 次に来る回の締切。完了にし忘れて締切が過ぎている定期予定でも「今より先の回」を返す（表示用・元データは変えない）。
   回数指定を使い切っていれば null */
function upcomingDue(it){
  var c=Object.assign({},it), now=new Date(), guard=0;
  while(parseItemDate(c)<now && guard++<3000){ if(!advanceRepeating(c)) return null; }
  return parseItemDate(c);
}

function complete(it, cardEl){
  // 同期で一覧が差し替わっていると、渡された項目は古いことがある。いまの項目で完了させる
  it=db.items.find(function(x){ return x.id===it.id; });
  if(!it){ render(); return; }
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
  var techo=techoStyle();
  // 手帳風でカードがあるときは、印が紙に着く時刻に合わせて鳴らす（動きがあるとき 0.04 秒、動きがないとき 0 秒）
  // 手帳風は「ぺたっ」（全部片付けた日は、あとで鳴らす皆済の音だけにして、同じ操作で2つ鳴らさない）。ゲーム風は今の「done」
  var nToday=bumpManualCount(); // 今日、自分で完了にした回数（この端末だけ・同期しない）
  if(!techo) playSfx("done");
  else if(!(reward.allClear && cardEl)) techoCompleteSfx(nToday, (cardEl && motionOn())?.04:0); // 皆済の印が出るとき（カードがあるとき）だけ、皆済の音に任せる
  var msg=techo
    ? (sub?"済。"+sub:"済の印を押しました")+"（+"+reward.gain+" EXP"+(reward.allClear?"・今日の締切は皆済":"")+(reward.levelUp?"・Lv."+reward.level+" に上がりました":"")+"）"
    : (sub?"完了。"+sub:"完了にしました")+"（EXP +"+reward.gain+(reward.allClear?"・本日のクエスト全クリア":"")+(reward.levelUp?"・Lv."+reward.level+" に上がりました":"")+"）";
  if(cardEl && techo){
    // 手帳風：帯は出さず、カードに「済」の印を押してから畳む。全部片付いた日は畳んだあとに「皆済」の印。
    // 動きを減らす設定のときも印は出す（動きなしで 0.4 秒見せてから、畳まずに一覧を描き直す）。消音中・電車の中でも手応えが画面に残る
    var after=function(){ render(); toast(msg); if(reward.allClear) playKaisai(reward.allClear, nToday); };
    stampCard(cardEl);
    if(motionOn()){
      foldCard(cardEl, after);
    } else {
      cardEl.querySelectorAll("button").forEach(function(b){ b.disabled=true; }); // 印を見せている間の二重操作を防ぐ
      setTimeout(after, 400);
    }
  } else if(cardEl && motionOn()){
    // 今日の全クリアは、達成の帯が閉じたあと（自動でもタップでも）続けて出す
    playQuestClear(it.title, reward, sub, reward.allClear?function(){ playAllClear(reward.allClear); }:null);
    foldCard(cardEl, render);
  } else {
    toast(msg);
    render();
  }
}

/* 完了の演出を使うか。設定でオフ、または端末側で「視差効果を減らす」なら使わない */
function motionOn(){
  if(db.settings.motion==="off") return false;
  return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
/* 演出を「手帳風」にしているか。動きの有無（motionOn）とは別に、言葉と印の見た目を手帳に寄せる */
function techoStyle(){ return db.settings.motion==="techo"; }

/* 手帳風の完了：カードに朱色の「済」の印を押す（畳むまでの間だけ見える） */
function stampCard(card){
  card.appendChild(h('<span class="done-stamp" aria-hidden="true">済</span>'));
}
/* 手帳風の全クリア：画面の中央に「皆済」の丸印を押す。タップでもすぐ閉じる */
function playKaisai(exp, count){
  playSfx("kaisai", {count:count}); // 皆済の印が出るのに合わせて「ぺたぺた…どん」（その日の完了の件数ぶん）
  var old=document.querySelector(".seal-pop"); if(old) old.remove();
  var el=h('<div class="seal-pop" role="status" aria-live="polite">'+
    '<div class="seal" aria-hidden="true"><span>皆済</span></div>'+
    '<p class="seal-cap">今日が締切のものは、すべて済みました<br><b class="num">+'+exp+' EXP</b></p></div>');
  var gone=false;
  function close(){ if(gone) return; gone=true; el.classList.add("out"); setTimeout(function(){ el.remove(); }, 260); }
  el.onclick=close; document.body.appendChild(el); setTimeout(close, 2200);
}

/* 画面の切り替え：中身を右から少しだけ（12px）滑らせながら表示する。
   進む・戻るで向きが変わったり大きく動いたりすると酔いやすいので、向きは常に同じ・距離は小さくする。
   動きは演出「なし」・視差効果を減らす設定で止まる（styles.css の .no-motion） */
function pageTransition(){
  main.classList.remove("page-in");
  // 動かないときはクラスを付けない（animationend が来ず残ると、あとで演出を戻した瞬間に動いてしまう）
  if(motionOn()){
    void main.offsetWidth; // 付け直しても動きが最初から始まるように、一度描画を確定させる
    main.classList.add("page-in");
  }
  playSfx(techoStyle()?"turn":"page");
}
main.addEventListener("animationend", function(e){
  if(e.target===main) main.classList.remove("page-in");
});

/* 効果音：Web Audio API でその場で作る（音声ファイルは使わない）。設定でオン/オフ、初期値はオフ。
   音を出す操作は、登録・完了・削除と画面の切り替えと、ボタンを押したとき。端末の設定（演出とは別）なので同期の対象外。
   土台の決まり：1操作1音（専用の音があるボタンには data-sfx="own" を付け、共通の音を重ねない）、
   すべての音をマスター→コンプレッサーに通す（続けて鳴っても割れない）、雑音は1秒ぶんを1回だけ作って使い回す、
   1秒以内に続けて鳴ったら小さくする、音ごとに高さと音量を少しずつばらつかせる */
var _audioCtx=null, _sfxOut=null, _noiseBuf=null, _lastSfxAt=0;
function soundOn(){ return db.settings.sound==="on"; }
function audioCtx(){
  if(_audioCtx) return _audioCtx;
  var AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) return null;
  try{ _audioCtx=new AC(); }catch(e){ _audioCtx=null; }
  return _audioCtx;
}
/* 値を ±ratio の範囲でばらつかせる（rnd は 0〜1 を返す関数。テストでは差し替える） */
function jitter(value, ratio, rnd){
  var r=(rnd||Math.random)();
  return value*(1+(r*2-1)*ratio);
}
/* 前に鳴らした時刻から1秒以内なら、音量を半分にする */
function sfxGain(lastAt, now){
  return (lastAt && now-lastAt<1000) ? .5 : 1;
}
/* すべての音の出口：マスター（0.6）→ コンプレッサー → 出力。一度だけ作る */
function audioOut(ctx){
  if(_sfxOut) return _sfxOut;
  var master=ctx.createGain(); master.gain.value=.6;
  var comp=ctx.createDynamicsCompressor();
  comp.threshold.value=-18; comp.knee.value=12; comp.ratio.value=4; comp.attack.value=.003; comp.release.value=.15;
  master.connect(comp); comp.connect(ctx.destination);
  _sfxOut=master;
  return _sfxOut;
}
/* 雑音（1秒・モノラル）は一度だけ作る。使うときは読み出す位置を乱数で変える */
function noiseBuffer(ctx){
  if(_noiseBuf) return _noiseBuf;
  var n=ctx.sampleRate, buf=ctx.createBuffer(1, n, ctx.sampleRate), d=buf.getChannelData(0);
  for(var i=0;i<n;i++) d[i]=Math.random()*2-1;
  _noiseBuf=buf;
  return _noiseBuf;
}
/* 雑音の一部（長さ len 秒）を、乱数の位置から鳴らす。立ち上がりと消え際に短い傾き（3ms）を付けて「プツッ」を防ぐ */
function noiseShot(ctx, dst, t0, len, peak, filter, att){
  att=att||.003;
  var src=ctx.createBufferSource(), g=ctx.createGain();
  src.buffer=noiseBuffer(ctx);
  g.gain.setValueAtTime(.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak,.0002), t0+att);
  g.gain.exponentialRampToValueAtTime(.0001, t0+len);
  if(filter){ src.connect(filter); filter.connect(g); } else src.connect(g);
  g.connect(dst);
  src.start(t0, Math.random()*(1-len-.01), len+.01);
}
/* ブラウザは画面の操作がないと音を出せない（特にiPhone）。最初のタップ/キー入力で用意しておく */
function unlockAudio(){
  if(!soundOn()) return;
  var ctx=audioCtx();
  if(ctx && ctx.state==="suspended") ctx.resume().catch(function(){});
}
["pointerdown","keydown","touchend"].forEach(function(ev){ document.addEventListener(ev, unlockAudio, {passive:true}); });
/* 音の並び [周波数Hz, 開始秒, 長さ秒, 音量(省略時 .16)]。長さは余韻が消えるまで。
   やわらかい正弦波に、1オクターブ上の小さな倍音を重ねてベルのような響きにし、ゆっくり減衰させる。
   画面の切り替えは何度も鳴るので、短く小さくする */
var SFX={
  add:    [[660,0,.65],[880,.12,1.15]],                       // 登録：軽い2音（上がる）
  done:   [[523.25,0,.8],[659.25,.12,.9],[783.99,.24,1.8]],   // 完了：ド・ミ・ソ（明るい）
  remove: [[440,0,.65],[329.63,.12,1.2]],                     // 削除：2音（下がる）
  page:   [[1046.5,0,.16,.06],[1567.98,.05,.22,.045]]          // 画面の切り替え：ごく短い2音
};
/* 音を鳴らす。opts.delay（秒）で鳴らす時刻を遅らせられる（印のアニメーションの着地に合わせるため）。
   音ごとに高さ（±6%）と音量（±15%）を少しずつばらつかせる */
function playSfx(kind, opts){
  opts=opts||{};
  if(!soundOn() || !(SFX[kind] || ["turn","tap","seal","kaisai","knock","pencil","tick","pita","ton","crumple","unfold"].indexOf(kind)>=0)) return;
  // 夜（22時〜7時）は、手帳風の脇役の音を鳴らさない（皆済は半分の音量で残す）。確認音（opts.always）は鳴らす
  var night=NIGHT_QUIET && techoStyle() && nightHour(new Date().getHours()) && !opts.always;
  if(night && TECHO_SIDE_KINDS.indexOf(kind)>=0) return;
  try{
    var ctx=audioCtx(); if(!ctx) return;
    if(ctx.state==="suspended") ctx.resume().catch(function(){});
    var now=Date.now();
    var bus=ctx.createGain(); // この音ぜんたいの音量（続けて鳴ったときは小さく、毎回少しばらつかせる）
    // 続けて鳴らす音（opts.follow：朱肉のあとの「ぺたっ」など）は、前の音の続きなので小さくしない
    bus.gain.value=(opts.follow?1:sfxGain(_lastSfxAt, now))*jitter(1, .15)*(opts.vol===undefined?1:opts.vol)*((night && kind==="kaisai")?.5:1);
    bus.connect(audioOut(ctx));
    if(!opts.follow) _lastSfxAt=now;
    var t0=ctx.currentTime+.02+(opts.delay||0);
    var pitch=jitter(1, .06);
    var tone=function(freq, s, len, peak){
      var osc=ctx.createOscillator(), g=ctx.createGain(), e=s+len;
      osc.type="sine"; osc.frequency.setValueAtTime(freq*pitch, s);
      g.gain.setValueAtTime(.0001, s);
      g.gain.exponentialRampToValueAtTime(peak, s+.015);
      g.gain.exponentialRampToValueAtTime(.0001, e);
      osc.connect(g); g.connect(bus);
      osc.start(s); osc.stop(e+.02);
    };
    if(kind==="turn"){ pageTurn(ctx, t0, bus); return; }
    if(kind==="tap"){ stampTap(ctx, t0, bus, pitch); return; }
    if(kind==="seal"){ stampSound(ctx, bus, t0, SEAL_PARAMS); return; }
    if(kind==="kaisai"){ kaisaiSound(ctx, bus, t0, opts.count); return; }
    if(kind==="ton"){ tonPair(ctx, bus, t0); return; }
    if(kind==="crumple"){ crumpleSound(ctx, bus, t0, 12+Math.floor(Math.random()*5)); return; }
    if(kind==="unfold"){ crumpleSound(ctx, bus, t0, 6); return; }
    if(kind==="knock"){ knockSound(ctx, bus, t0); return; }
    if(kind==="pencil"){ pencilSound(ctx, bus, t0); return; }
    if(kind==="tick"){ tickSound(ctx, bus, t0); return; }
    if(kind==="pita"){ pitaSound(ctx, bus, t0); return; }
    SFX[kind].forEach(function(n){
      var s=t0+n[1], peak=n[3]||.16;
      tone(n[0], s, n[2], peak);         // 基音
      tone(n[0]*2, s, n[2]*.5, peak/4);  // 倍音（早めに消えて、余韻は丸く残る）
    });
  }catch(e){ /* 音が出せなくても操作は止めない */ }
}

/* 完了の音の回数：毎日何十回も鳴る「ぺたっ」をどう控えるか。次の5つから1つ選ぶ（円卓の批評で最も点が高かった "first"）。
   first=その日の初回だけ「ぺたっ」、以降は無音／kaisai-only=完了は無音で皆済だけ／fade=1〜3回目は通常、4回目以降は半分の音量／
   knock=初回は「ぺたっ」、2件目以降は半分の「こつ」／three=先頭の3回だけ。皆済の「どん」はこの制限の外で、いつも全部鳴る */
var SEAL_MODE="first";
/* 手帳風の脇役の音（夜は鳴らさない）。皆済は含めない */
var TECHO_SIDE_KINDS=["seal","knock","pencil","tick","pita","turn","ton","crumple","unfold"];
/* 夜の静音（22時〜7時は、皆済以外の手帳風の音を止め、皆済は半分の音量）を使うか。既定はオフ（夜でも昼と同じに鳴る）。使うときは true にする */
var NIGHT_QUIET=false;
/* 夜（22時〜7時）か。時刻だけで決まる */
function nightHour(h){ return h>=22 || h<7; }
/* その日の n 回目（1から数える）の完了で、鳴らす音と音量を返す。{kind:"seal"|"knock"|null, vol} */
function sealLevel(n, mode){
  switch(mode){
    case "kaisai-only": return {kind:null, vol:0};
    case "fade":        return {kind:"seal", vol:n<=3?1:.5};
    case "knock":       return n<=1 ? {kind:"seal", vol:1} : {kind:"knock", vol:.5};
    case "three":       return n<=3 ? {kind:"seal", vol:1} : {kind:null, vol:0};
    default:            return n<=1 ? {kind:"seal", vol:1} : {kind:null, vol:0}; // "first"
  }
}
/* 今日、自分で完了にした回数（日付と組で端末内に覚える。日付が変わると0に戻る。同期しない） */
function sfxDay(){
  var today=toLocalISO(new Date());
  try{ var o=JSON.parse(store.get("sfx-day")); if(o && o.date===today && typeof o.manual==="number") return o; }catch(e){}
  return {date:today, manual:0};
}
function bumpManualCount(){
  var o=sfxDay(); o.manual++;
  store.set("sfx-day", JSON.stringify(o));
  return o.manual;
}
/* 手帳風の完了の音：朱肉（5回ごと）→ 回数に応じた「ぺたっ」 */
function techoCompleteSfx(n, delay){
  var lv=sealLevel(n, SEAL_MODE);
  if(n>0 && n%5===0){ playSfx("ton", {delay:delay}); delay+=.2; } // 朱肉を付け直す「とんとん」のあとに、ハンコ
  if(lv.kind) playSfx(lv.kind, {delay:delay, vol:lv.vol, follow:n%5===0});
}

/* ---- 手帳風の音（手帳風の演出を選んでいるときだけ。ゲーム風は上の音のまま） ----
   ハンコ・朱肉・机の物音を、雑音と短い正弦波で合成する。iPhone のスピーカーは約200Hz未満をほとんど出せないので、
   重さは 300〜600Hz の帯域で出す。1つの合成関数 stampSound(p) に、長さ・高さ・音量などの値を渡して「ぺたっ」「どん」を作る */
var SEAL_PARAMS={ // 完了「ぺたっ」：ゴム印の柔らかい押しつぶし。小さく短く（約0.15秒）
  lp:{f0:1200, f1:350, time:.08, q:1.5, peak:.12, decay:.12},  // 胴：雑音をローパスに通し、通す高さを下げる
  body:{f0:300, f1:200, time:.06, peak:.05, decay:.1},         // 補助の胴：正弦波を下げる
  grain:{f:2500, q:1, peak:.05}                                // 刻印：6ms の粒
};
var DON_PARAMS={ // 皆済の「どん」：「ぺたっ」と同じ作りで、重く長い（約0.25秒）
  lp:{f0:1000, f1:250, time:.12, q:1.5, peak:.18, decay:.25},
  body:{f0:250, f1:160, time:.12, peak:.09, decay:.25},
  // 200〜800Hz の倍音を小さく足して、脳に低音を補わせる（iPhone で聞こえない帯域を避ける）。3kHz を超える成分は刻印の粒だけ
  partials:[[320,.02],[480,.015],[640,.012]],
  grain:{f:2500, q:1, peak:.06}
};
function stampSound(ctx, dst, t0, p, vol){
  var v=vol===undefined?1:vol; // 音量の倍率（皆済の「ぺたぺた」は、だんだん小さくする）
  var k=jitter(1, .08); // 毎回、フィルターの高さを少しばらつかせる
  if(p.lp){
    var lp=ctx.createBiquadFilter(); lp.type="lowpass"; lp.Q.value=p.lp.q;
    lp.frequency.setValueAtTime(p.lp.f0*k, t0); lp.frequency.exponentialRampToValueAtTime(p.lp.f1*k, t0+p.lp.time);
    noiseShot(ctx, dst, t0, p.lp.decay, p.lp.peak*v, lp);
  }
  var sine=function(f0, f1, time, peak, dec){
    var o=ctx.createOscillator(), g=ctx.createGain();
    o.type="sine"; o.frequency.setValueAtTime(f0*k, t0); o.frequency.exponentialRampToValueAtTime(f1*k, t0+time);
    g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(peak*v, t0+.004); g.gain.exponentialRampToValueAtTime(.0001, t0+dec);
    o.connect(g); g.connect(dst); o.start(t0); o.stop(t0+dec+.02);
  };
  if(p.body) sine(p.body.f0, p.body.f1, p.body.time, p.body.peak, p.body.decay);
  (p.partials||[]).forEach(function(q){ sine(q[0], q[0]*.97, p.body.time, q[1], p.body.decay); });
  if(p.grain){
    var bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=p.grain.f*k; bp.Q.value=p.grain.q;
    noiseShot(ctx, dst, t0, .006, p.grain.peak*v, bp);
  }
}
/* 朱肉「とんとん」：朱肉に印を付け直す音。ローパス 500Hz・40ms を 90ms 間隔で2回（その日の完了が5の倍数になったとき、「ぺたっ」の前に入る） */
function tonPair(ctx, dst, t0){
  var ton=function(at){
    var lp=ctx.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=500*jitter(1,.08);
    noiseShot(ctx, dst, at, .04, .07, lp);
  };
  ton(t0); ton(t0+.09);
}
/* 皆済「ぺたぺた…どん」（0.8秒以内）：その日に完了した件数（上限3）ぶん、「ぺたっ」を60ms間隔でだんだん小さく鳴らしてから、重い「どん」 */
function kaisaiSound(ctx, dst, t0, count){
  var pets=Math.max(1, Math.min(3, count||1)), vols=[1, .7, .5];
  for(var i=0;i<pets;i++) stampSound(ctx, dst, t0+i*.06, SEAL_PARAMS, vols[i]);
  stampSound(ctx, dst, t0+pets*.06+.12, DON_PARAMS);
}
/* 削除「くしゃっ」・ゴミ箱から戻す「かさっ」（0.15秒）：紙を丸める・広げる音。3ms の雑音の粒を、
   粒の長さの2倍以上の無音をはさんでまばらに並べる（砂嵐に聞こえないように）。粒ごとに中心 2〜5kHz の乱数 */
function crumpleSound(ctx, dst, t0, grains){
  var span=.15, slot=span/grains;
  for(var i=0;i<grains;i++){
    var bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=2;
    bp.frequency.value=2000+Math.random()*3000;
    // 粒は 3ms。次の粒との間に 6ms 以上の無音が残るよう、枠の中の前のほうに置く
    noiseShot(ctx, dst, t0+i*slot+Math.random()*Math.max(0,slot-.009), .003, .05, bp);
  }
}
/* ボタン共通「こつ」（40ms 以内）：指先や鉛筆の尻で机を軽く叩く音 */
function knockSound(ctx, dst, t0){
  var k=jitter(1, .08);
  var bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=1800*k; bp.Q.value=4;
  noiseShot(ctx, dst, t0, .004, .035, bp);
  var o=ctx.createOscillator(), g=ctx.createGain();
  o.type="sine"; o.frequency.setValueAtTime(900*k, t0);
  g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(.02, t0+.003); g.gain.exponentialRampToValueAtTime(.0001, t0+.03);
  o.connect(g); g.connect(dst); o.start(t0); o.stop(t0+.04);
}

/* 手帳風の細かい音。どれも雑音の粒が中心で、音程はない */
/* 登録：鉛筆「カリカリ」（約0.3秒）。ざらついた紙の上の黒鉛の引っかき音：雑音の粒を4〜6個、粒ごとに帯域・間隔・音量をばらつかせる */
function pencilSound(ctx, dst, t0){
  var n=4+Math.floor(Math.random()*3), at=t0;
  for(var i=0;i<n;i++){
    var bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=3;
    bp.frequency.value=3000+Math.random()*2500;          // 中心 3〜5.5kHz
    noiseShot(ctx, dst, at, .015+Math.random()*.015, jitter(.05,.3), bp); // 1粒 15〜30ms、音量 ±30%
    at+=.04+Math.random()*.025;                          // 粒の間隔 40〜65ms
  }
}
/* メモのチェック・今日の一手の印：レ点「シュッ」（60ms）。赤ペンでレ点を入れる音：通す高さを 3.5→6kHz に上げる */
function tickSound(ctx, dst, t0){
  var k=jitter(1,.1);
  var bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=2;
  bp.frequency.setValueAtTime(3500*k, t0); bp.frequency.exponentialRampToValueAtTime(6000*k, t0+.06);
  noiseShot(ctx, dst, t0, .06, .04, bp, .01);
}
/* 延期・この回は休み：控えめな「ぴたっ」（25ms、高い音なし）。付箋を貼り直す音 */
function pitaSound(ctx, dst, t0){
  var lp=ctx.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=800*jitter(1,.08);
  noiseShot(ctx, dst, t0, .025, .04, lp);
  var o=ctx.createOscillator(), g=ctx.createGain();
  o.type="sine"; o.frequency.setValueAtTime(320*jitter(1,.08), t0);
  g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(.02, t0+.004); g.gain.exponentialRampToValueAtTime(.0001, t0+.03);
  o.connect(g); g.connect(dst); o.start(t0); o.stop(t0+.04);
}

/* ボタンを押したときの音：ゲームの決定音のような、明るく弾む「ぽこっ」（約0.5秒）。
   音程が下から跳ね上がる三角波に、低めの胴の音と、きらめく高音、当たった瞬間の短い雑音を重ねる。
   スマホのスピーカーでも聞こえるよう、300Hz 以上を主にする。出口（マスター→コンプレッサー）は playSfx が用意する */
function stampTap(ctx, t0, dst, pitch){
  var k=.75*(pitch||1); // 基準の高さ（試聴で選んだ高さ）に、毎回のばらつきを掛ける
  var tone=function(f0, f1, bend, peak, dec, type){
    var o=ctx.createOscillator(), g=ctx.createGain();
    o.type=type; o.frequency.setValueAtTime(f0*k, t0); o.frequency.exponentialRampToValueAtTime(f1*k, t0+bend);
    g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0+.003); g.gain.exponentialRampToValueAtTime(.0001, t0+dec);
    o.connect(g); g.connect(dst); o.start(t0); o.stop(t0+dec+.02);
  };
  tone(700, 1180, .045, .26, .5, "triangle");  // 跳ね上がる主な音
  tone(330, 250, .1, .22, .4, "sine");         // 胴
  tone(2360, 2360, .01, .07, .25, "sine");     // きらめき
  // 当たった瞬間の短い雑音（使い回す雑音の一部を、帯域フィルターに通す）
  var bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=3800; bp.Q.value=.6;
  noiseShot(ctx, dst, t0, .012, .1, bp);
}

/* ボタンを押したときの短い音。専用の音がある操作（data-sfx="own"）と、画面の切り替え（タブ）には重ねない（1操作1音）。
   無効のボタンと、操作できない間（読み込み中の inert）は鳴らさない */
document.addEventListener("click",function(e){
  if(!soundOn()) return;
  var t=e.target && e.target.closest ? e.target.closest("button, summary, input[type=checkbox], [role=button]") : null;
  if(!t || t.disabled || t.getAttribute("aria-disabled")==="true" || t.closest('[inert], .tab, [data-sfx="own"]')) return;
  playSfx(techoStyle()?"knock":"tap"); // 手帳風は机を叩く「こつ」、ゲーム風は明るい「ぽこっ」
});

/* 手帳風の画面の切り替え：紙をめくる「さっ」という音。雑音を帯域フィルターに通し、
   通す高さを上げながら短く鳴らす（約0.2秒） */
function pageTurn(ctx, t0, dst){
  var len=.22;
  var bp=ctx.createBiquadFilter();
  bp.type="bandpass"; bp.Q.value=1.2;
  bp.frequency.setValueAtTime(1800, t0);
  bp.frequency.exponentialRampToValueAtTime(5200, t0+len);
  noiseShot(ctx, dst, t0, len, .09, bp);
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
    sparks+='<i data-st="--x:'+Math.round(Math.cos(a)*d*1.9)+'px;--y:'+Math.round(Math.sin(a)*d*.6)+'px;--d:'+(k%5)*50+'ms"></i>'; }
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
  // 直近7日（6日前〜今日）に自分で完了した日があるか。ヘッダーのマスに使う
  var week=[], t=new Date();
  for(var k=6;k>=0;k--){ var x=new Date(t.getFullYear(),t.getMonth(),t.getDate()-k); week.push({key:toLocalISO(x), on:!!days[toLocalISO(x)]}); }
  return {n:n, doneToday:doneToday, week:week};
}

/* ---- 達成カレンダーと実績バッジ（完了の記録 db.completions から毎回計算する。データは増やさない） ----
   数えるのは、自分で完了にした記録だけ（自動完了 kind:"auto" と、全クリアのボーナス kind:"bonus" は数えない） */
function isOwnCompletion(c){ return c.kind!=="auto" && c.kind!=="bonus"; }
var ACTIVITY_WEEKS=26;
/* 1日の完了件数を、色の5段階（GitHub の草と同じ）にする：0件・1件・2件・3〜4件・5件以上 */
function activityLevel(n){ return n<=0?0:n===1?1:n===2?2:n<=4?3:4; }
/* 達成カレンダー：今日を含む週までの26週（日曜はじまり・182マス）。マスごとに、その日の完了件数・色の段階（level 0〜4）・前倒しで終えた日か。
   cells は週ごとに7つずつ（日〜土）並ぶ。今日より先のマスは future:true */
function buildActivityGrid(completions, today){
  var byDay={}, clearDays={};
  (completions||[]).forEach(function(c){
    // 皆済した日（全クリアのボーナス kind:"bonus" の記録がある日）。件数には含めず、印だけ付ける。
    // 完了の記録は COMPLETION_LIMIT（500件）を超えると古いものから消える（trimCompletions）ので、
    // 1日に完了する件数が多い人ほど、古い週の皆済の印は残らない（目安：1日5件なら約100日＝14週ぶん）
    if(c.kind==="bonus") clearDays[toLocalISO(new Date(c.doneAt))]=true;
    if(!isOwnCompletion(c)) return;
    var k=toLocalISO(new Date(c.doneAt));
    var e=byDay[k]||(byDay[k]={n:0, early:false});
    e.n++; if(c.kind==="early") e.early=true;
  });
  var t=startOfDay(today);
  var first=new Date(t.getFullYear(), t.getMonth(), t.getDate()-t.getDay()-(ACTIVITY_WEEKS-1)*7);
  var todayKey=toLocalISO(t), cells=[], activeDays=0, total=0, kaisaiDays=0;
  for(var k=0;k<ACTIVITY_WEEKS*7;k++){
    var d=new Date(first.getFullYear(), first.getMonth(), first.getDate()+k), key=toLocalISO(d);
    var future=key>todayKey, e=byDay[key]||{n:0, early:false}, n=future?0:e.n;
    if(n){ activeDays++; total+=n; }
    if(!future && clearDays[key]) kaisaiDays++;
    cells.push({key:key, dow:d.getDay(), n:n, level:activityLevel(n), early:!future&&e.early, allClear:!future&&!!clearDays[key], future:future, today:key===todayKey});
  }
  return {cells:cells, weeks:ACTIVITY_WEEKS, activeDays:activeDays, total:total, kaisaiDays:kaisaiDays};
}
/* 上の「月」の目盛り：月が替わる週の列に月の数字を置く（列は 1 から数える）。
   最初の列が月の途中で、次の目盛りが近すぎる（3列未満）ときは、最初の目盛りを省く */
function activityMonthLabels(cells){
  var labels=[], prev=-1;
  for(var w=0;w<cells.length/7;w++){
    var m=new Date(cells[w*7].key+"T00:00:00").getMonth();
    if(m!==prev){ labels.push({col:w+1, month:m+1}); prev=m; }
  }
  if(labels.length>1 && labels[1].col-labels[0].col<3) labels.shift();
  return labels;
}
/* 完了した日の並び（YYYY-MM-DD の昇順・重複なし）から、いちばん長い連続日数 */
function longestStreak(dayKeys){
  var keys=Array.from(new Set(dayKeys)).sort(), best=0, run=0, prev=null;
  keys.forEach(function(k){
    var d=new Date(k+"T00:00:00");
    run=(prev && daysBetween(prev,d)===1) ? run+1 : 1;
    if(run>best) best=run;
    prev=d;
  });
  return best;
}
/* 実績バッジ。current は今の値、goal は達成の条件、done は達成済みか */
var BADGE_DEFS=[{id:"streak7", name:"連続7日", desc:"7日続けて、毎日1件以上完了した", goal:7}, {id:"early10", name:"前倒し10回", desc:"締切の24時間以上前に完了した回数", goal:10}, {id:"clear5", name:"全クリア5日", desc:"今日の締切をすべて片付けた日の数", goal:5}, {id:"lv10", name:"Lv.10", desc:"レベル10に到達した", goal:10}];
function buildBadges(completions, expCarry){
  var list=completions||[], exp=(expCarry||0);
  list.forEach(function(c){ exp+=(c.exp||0); });
  var current={
    streak7:longestStreak(list.filter(isOwnCompletion).map(function(c){ return toLocalISO(new Date(c.doneAt)); })),
    early10:list.filter(function(c){ return c.kind==="early"; }).length,
    clear5:new Set(list.filter(function(c){ return c.kind==="bonus"; }).map(function(c){ return toLocalISO(new Date(c.doneAt)); })).size,
    lv10:levelOf(exp)
  };
  return BADGE_DEFS.map(function(b){
    var cur=current[b.id];
    return {id:b.id, name:b.name, desc:b.desc, goal:b.goal, current:Math.min(cur,b.goal), done:cur>=b.goal};
  });
}
/* 完了タブの先頭：GitHub の草のような、直近26週のマス。色は件数の5段階。前倒しで終えた日は青い枠。
   色だけに頼らず、各マスに日付と件数を title に入れ、押すと下に同じ文が出る（スマホでも読める） */
function achievementGrid(){
  var g=buildActivityGrid(db.completions, new Date());
  var el=h('<section class="ach" aria-label="達成カレンダー"><div class="ach-head"><b>達成カレンダー</b><span class="note">直近'+g.weeks+'週・完了した日 '+g.activeDays+' 日／'+g.total+' 件</span></div>'+
    '<div class="ach-board"><span></span><div class="ach-months" aria-hidden="true"></div>'+
    '<div class="ach-dows" aria-hidden="true"><span>月</span><span>水</span><span>金</span></div>'+
    '<div class="ach-grid" role="img" aria-label="直近'+g.weeks+'週に完了した日は '+g.activeDays+' 日、合計 '+g.total+' 件'+(g.kaisaiDays?'、その日の締切を全部片付けた（皆済の）日は '+g.kaisaiDays+' 日':'')+'"></div></div>'+
    '<p class="ach-pick note" role="status">マスを押すと、その日の件数が出ます</p>'+
    '<div class="ach-legend note">少<span class="ach-sw g0"></span><span class="ach-sw g1"></span><span class="ach-sw g2"></span><span class="ach-sw g3"></span><span class="ach-sw g4"></span>多'+
    '<span class="ach-sw g1 early"></span>前倒しで完了した日<span class="ach-key"><span class="ach-sw kaisai"></span>✓＝その日の締切を全部片付けた日</span></div></section>');
  var grid=el.querySelector(".ach-grid"), months=el.querySelector(".ach-months"), pick=el.querySelector(".ach-pick");
  activityMonthLabels(g.cells).forEach(function(l){
    months.appendChild(h('<span data-st="grid-column:'+l.col+'">'+l.month+'月</span>'));
  });
  g.cells.forEach(function(c){
    var d=new Date(c.key+"T00:00:00");
    var label=(d.getMonth()+1)+"/"+d.getDate()+"（"+DOW[d.getDay()]+"）"+(c.future?"":" "+c.n+"件"+(c.early?"・前倒し":"")+(c.allClear?"・皆済":""));
    var cell=h('<i class="'+(c.future?"gf":"g"+c.level)+(c.early?" early":"")+(c.allClear?" kaisai":"")+(c.today?" now":"")+'" title="'+escHtml(label)+'" data-label="'+escHtml(label)+'"></i>');
    cell.onclick=function(){ pick.textContent=label; };
    grid.appendChild(cell);
  });
  return el;
}
/* 設定の「演出」の節に並べる実績バッジ（未達成は薄く、進み具合を文字で出す） */
function achievementBadges(){
  var el=h('<div class="ach-badges"><div class="ach-head"><b>実績バッジ</b></div><ul></ul></div>');
  var ul=el.querySelector("ul");
  buildBadges(db.completions, db.expCarry).forEach(function(b){
    ul.appendChild(h('<li class="'+(b.done?"done":"todo")+'"><span class="ach-mark" aria-hidden="true">'+(b.done?"✓":"◇")+'</span>'+
      '<span><b>'+escHtml(b.name)+'</b><span class="note">'+escHtml(b.desc)+'</span></span>'+
      '<span class="ach-state">'+(b.done?"達成":"未達成 "+b.current+"/"+b.goal)+'</span></li>'));
  });
  return el;
}

/* 連続日数の印。ラジオ体操カードのように、直近7日のうち自分で完了した日のマスを塗る（右端が今日） */
function streakHtml(st, warn){
  var cells=st.week.map(function(w,i){
    return '<i class="'+(w.on?"on":"")+(i===st.week.length-1?" today":"")+'"></i>';
  }).join("");
  var onDays=st.week.filter(function(w){ return w.on; }).length;
  var full=(onDays===st.week.length); // 直近7日すべて完了した日がある＝皆勤
  var label="連続 "+st.n+" 日"+(warn?"・今日まだ":"")+"。直近7日で完了した日："+onDays+" 日"+(full?"（皆勤）":"");
  return '<span class="lv-streak'+(warn?' warn':'')+'" role="img" aria-label="'+label+'" title="'+(warn?"今日1件完了すると連続が続きます":full?"直近7日、毎日1件以上完了しました（皆勤）":"毎日1件以上完了した日数（マスは左が6日前、右端が今日）")+'">'+
    '<small>連続</small><b class="num">'+st.n+'</b>日<span class="lv-cells" aria-hidden="true">'+cells+'</span>'+
    (full?'<span class="lv-kaikin" aria-hidden="true">皆勤</span>':'')+
    (warn?'<span class="lv-todo">今日まだ</span>':'')+'</span>';
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
    (st.n?streakHtml(st, warn):'');
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
    sparks+='<i data-st="--x:'+Math.round(Math.cos(a)*d*1.8)+'px;--y:'+Math.round(Math.sin(a)*d*.55)+'px;--d:'+(k%4)*40+'ms"></i>';
  }
  var el=h('<div class="quest" role="status" aria-live="polite">'+
    '<div class="quest-band"><div class="quest-sparks" aria-hidden="true">'+sparks+'</div>'+
      '<div class="quest-kicker">MISSION COMPLETE</div>'+
      '<div class="quest-title">ミッション達成！</div>'+
      '<div class="quest-name">「'+escHtml(title)+'」</div>'+
      (sub?'<div class="quest-sub">'+escHtml(sub)+'</div>':'')+
      '<div class="quest-reward"><span class="quest-exp">EXP +'+rw.gain+'</span><span class="quest-bonus">'+rw.bonus+'</span></div>'+
      '<div class="quest-lv"><span>Lv.'+rw.level+'</span><span class="quest-bar"><b data-st="--from:'+fromPct+'%;--to:'+toPct+'%"></b></span><span>'+rw.into+'/'+EXP_PER_LEVEL+'</span></div>'+
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
    saveAuto(); // 機械の処理なので、「人の未送信の変更」の印は立てない
    toast(affected===1?"期限を過ぎた締切を自動で完了にしました":"期限を過ぎた"+affected+"件を自動で完了にしました");
    scheduleAutoSync();
  }
  return affected;
}

/* 保存先の新しい内容の取り込みを先に済ませてから、期限切れの自動完了を行う。
   順序が逆だと、自動完了の保存で「この端末に未同期の変更がある」と判断され、
   他の端末の更新を取り込めず、次の同期も 409 で止まる。
   起動と画面復帰（block=true）では、読み終えるまで「読み込み中」を出して編集させない（古い内容のまま編集して衝突するのを防ぐ）。
   待つのは最大4秒。過ぎたら編集できるようにして「圏外のため前回の内容」と出す（読めたら、その時点で帯を消す） */
var _refreshing=null, _srvState="fresh", _deferRefresh=false, _lastRefreshAt=0;
var SRV_WAIT_MS=4000;
function editingBusy(){
  var a=document.activeElement;
  return !!(dlg && dlg.open) || !!(a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
function srvBarText(state){
  if(state==="loading") return "保存先の最新の内容を読み込んでいます…";
  var raw=store.get("gh-last-pulled"), t=raw?new Date(raw):null;
  var when=(t && !isNaN(t.getTime())) ? "（"+(t.getMonth()+1)+"/"+t.getDate()+" "+pad(t.getHours())+":"+pad(t.getMinutes())+" 時点）" : "";
  return "圏外のため、前回の内容"+when+"を表示しています。編集はでき、つながったときに送ります。";
}
/* 画面の状態: loading=読み込み中（編集不可）、fresh=最新、offline=読めず前回の内容 */
function setSrvState(state){
  _srvState=state;
  var bar=document.getElementById("srvBar"), fab=document.getElementById("fabAdd");
  if(bar){ bar.hidden=(state==="fresh"); bar.textContent=state==="fresh"?"":srvBarText(state); bar.className="srvbar"+(state==="offline"?" srv-off":""); }
  main.inert=(state==="loading"); fab.inert=(state==="loading");
  main.setAttribute("aria-busy", state==="loading"?"true":"false");
}
function refreshThenAutoComplete(block){
  if(_refreshing) return _refreshing;
  if(editingBusy()){ _deferRefresh=true; return Promise.resolve(); } // 登録・編集中や入力中は置き換えない。終わってから行う
  _deferRefresh=false; _lastRefreshAt=Date.now();
  // アクセスキーが無い端末は同期しないので、待たせない
  var wait=block===true && !!store.get("cf-key");
  if(wait) setSrvState("loading");
  var timer;
  var limit=new Promise(function(resolve){ timer=setTimeout(function(){ resolve("timeout"); }, SRV_WAIT_MS); });
  var pull=autoPullIfStale().then(function(ok){
    setSrvState(ok===false ? "offline" : "fresh"); // 遅れて読めたときも、ここで帯を消す
    if(ok===true && hasUnsyncedChanges()) autoSyncIfConfigured(); // 読み終えたら、人の未送信の変更を先に送る（409 なら衝突の流れへ）
    return ok;
  });
  _refreshing=Promise.race([pull, limit]).then(function(r){
    clearTimeout(timer);
    if(r==="timeout") setSrvState("offline"); // 4秒待っても読めない → 編集できるようにして、前回の内容と知らせる（読めたら pull 側で消える）
    _refreshing=null;
    if(autoCompleteOverdueItems()>0) softRender();
  });
  return _refreshing;
}
/* 置き換えを保留していたとき、登録・編集が終わってから行う */
function runDeferredRefresh(){ if(_deferRefresh && !editingBusy()) refreshThenAutoComplete(true); }

/* 繰り返し1回分だけ日付を進める。月・年単位は基準日(anchorDay)を保ち、
   その月に無い日(31日・2/29など)は月末に丸める。
   （setMonthのままだと 1/31 の翌月が 3/3 になってしまうため） */



/* 繰り返しのうち、指定日の回だけを取りやめる。
   取りやめたのが「次の回」そのものなら、締切を次の回へ進める
   （進めないと、取りやめたはずの回が一覧で締切として残り、過ぎると超過になるため） */
function skipOccurrence(id, dateKey){
  var ended=false;
  db.items.forEach(function(i){
    if(i.id!==id) return;
    if((i.skip||[]).indexOf(dateKey)<0) i.skip=(i.skip||[]).concat([dateKey]);
    if(toLocalISO(parseItemDate(i))===dateKey){
      delete i.pick;
      if(!advanceRepeating(i)){ i.done=true; i.doneAt=new Date().toISOString(); ended=true; }
    }
    i.seq=(i.seq||0)+1;
  });
  save(); render();
  if(techoStyle()) playSfx("pita");
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
function currentTheme(){
  var t=document.documentElement.getAttribute("data-theme");
  return THEMES.indexOf(t)>=0 ? t : resolveTheme(readSavedTheme(), themePrefersDark());
}
/* 画面に反映する（<html data-theme>・ブラウザ上端の色・◐ ボタンの説明）。保存はしない */
function applyTheme(t){
  t=t||currentTheme();
  document.documentElement.setAttribute("data-theme",t);
  var bg=getComputedStyle(document.documentElement).getPropertyValue("--color-background-body").trim();
  var meta=document.querySelector('meta[name="theme-color"]');
  if(meta && bg) meta.setAttribute("content",bg);
  var btn=document.getElementById("themeBtn");
  if(btn){
    var next=THEMES[(THEMES.indexOf(t)+1)%THEMES.length];
    btn.setAttribute("aria-label","テーマ："+THEME_NAMES[t]+"（押すと"+THEME_NAMES[next]+"に切り替え）");
  }
}
/* 選んだテーマを、この端末に保存して反映する。保存できなくても、その回は切り替わる */
function setTheme(t){ saveTheme(t); applyTheme(t); }
/* 旧設定（自動／ライト／ダーク）を一度だけ引き継ぐ：ライト→抹茶、ダーク→墨、自動はまだ選んでいない扱い */
function migrateLegacyTheme(){
  var old=db.settings && db.settings.theme;
  if(old===undefined) return;
  if(!readSavedTheme()){
    if(old==="light") saveTheme("matcha");
    else if(old==="dark") saveTheme("dark");
  }
  delete db.settings.theme; saveRaw();
}
try{
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){
    if(!readSavedTheme()){ applyTheme(resolveTheme(null, themePrefersDark())); render(); } // まだ選んでいない端末だけ、端末の設定に合わせる
  });
}catch(e){}

var toastEl=document.getElementById("toast"), toastTimer=null;
var toastMsgEl=document.getElementById("toastMsg"), toastActionEl=document.getElementById("toastAction");
function toast(msg, actionLabel, actionFn){
  toastMsgEl.textContent=msg; toastEl.classList.add("on");
  if(actionLabel&&actionFn){
    toastActionEl.textContent=actionLabel;
    toastActionEl.hidden=false;
    toastActionEl.onclick=function(){ actionFn(); toastEl.classList.remove("on"); clearTimeout(toastTimer); };
  } else {
    toastActionEl.hidden=true;
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
    downloadIcsPreferWorker(list, "deadlines");
    var guide=h('<div class="sec bd-blue">'+
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
   他の端末で更新されていないか確かめるため、Cloudflareの自動取り込み(pullDone)が終わるのを
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
   ホーム画面のアプリは古い画面を長く保持することがあるため、
   起動時と復帰時にサーバー側の更新を確認し、変わっていれば読み直す */
var APP_BUILD=null;
function checkForUpdate(){
  if(location.protocol==="file:") return;
  // index.html・app.js・styles.css を見る（スタンプの更新を忘れて app.js や styles.css だけ変えた場合も、長さの違いで気づける）
  var fresh=function(url){ return fetch(url+"?_="+Date.now(),{cache:"no-store"}).then(function(res){ return res.ok?res.text():null; }); };
  var path=function(f){ return new URL(f,location.href).pathname; };
  Promise.all([fresh(location.pathname), fresh(path("app.js")), fresh(path("styles.css"))])
    .then(function(r){
      var html=r[0], js=r[1], css=r[2];
      if(!html || js===null || css===null) return;
      // ビルドスタンプ（無ければ内容の長さ）を版番号として使う
      var m=html.match(/<meta name="build-stamp" content="([^"]*)">/);
      var build=(m?m[1]:"")+"/"+html.length+"/"+js.length+"/"+css.length;
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
  checkForUpdate();
  if(Date.now()-_lastRefreshAt>=30000) refreshThenAutoComplete(true); // 前回の確認から30秒以上たっていれば、読み終えるまで待たせる
});

/* 定期的な再描画。入力欄を操作中や設定タブを開いているときは、
   打ちかけの内容(検索語・トークンなど)が消えないよう描画を見送る */
/* 入力中は描き直さない（打ちかけの文字が消えるため）。入力欄から離れたときに、止めていた描き直しを行う */
var renderAfterInput=false;
function softRender(){
  var a=document.activeElement;
  if(view==="set") return;
  if(a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){ renderAfterInput=true; return; }
  renderAfterInput=false;
  render();
}
main.addEventListener("focusout",function(){
  if(renderAfterInput) setTimeout(softRender,0);
  setTimeout(runDeferredRefresh,0);
});

/* ========== 起動 ========== */
document.querySelectorAll(".tab").forEach(function(t){
  t.onclick=function(){ view=t.dataset.view; window.scrollTo(0,0); render(); };
});
document.getElementById("gearBtn").onclick=function(){ view=(view==="set")?"list":"set"; window.scrollTo(0,0); render(); };
document.getElementById("themeBtn").onclick=function(){
  var next=THEMES[(THEMES.indexOf(currentTheme())+1)%THEMES.length];
  setTheme(next); render(); toast("テーマ："+THEME_NAMES[next]);
};
document.getElementById("fabAdd").onclick=function(){ openDialog(null); };
load(); migrateLegacyTheme(); applyTheme();
forgetLegacySettings();
render();
handleExportParam();
handleActionParam();
setInterval(function(){ if(!_refreshing && _srvState!=="loading") autoCompleteOverdueItems(); softRender(); }, 60000); // 残り時間の更新とあわせて自動完了も確認（取り込み中は待つ）
checkForUpdate();
var _pullDone=refreshThenAutoComplete(true); // 他の端末の更新の取り込み → 自動完了 の順
handleDoneParam(_pullDone);
setInterval(checkForUpdate, 10*60000); // 10分ごとに更新を確認
setInterval(function(){ refreshThenAutoComplete(); }, 10*60000); // 10分ごとに保存先の新しい内容を確認
})();
