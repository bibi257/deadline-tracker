/* WebClass の成績表 CSV を読み、締切の候補にする（画面・保存・通信に触れない処理だけ）。
   app-calc.js と同じく即時関数の中で定義し、DTWebClass の1つの名前だけを外に出す。
   CSV の中身は端末の中だけで処理する。先頭の数行（作成日・作成者など）は読み捨て、どこにも残さない。 */
(function(root){
"use strict";

var WC_MAX_BYTES=2*1024*1024, WC_MAX_ROWS=2000, WC_TITLE_MAX=80;
/* 見出しの列名。並び順は決め打ちせず、名前で探す */
var WC_COLS=["学部","学科","コース名","教材","締切","実施日","最高点","状態"];
var WC_CAT="課題";

/* 文字コードの判定：先頭が BOM なら UTF-8。なければ UTF-8 として厳密に読み、読めなければ Shift_JIS */
function wcDecode(bytes){
  if(bytes.length>WC_MAX_BYTES) throw new Error("ファイルが大きすぎます（2MB まで）");
  if(bytes.length>=3 && bytes[0]===0xEF && bytes[1]===0xBB && bytes[2]===0xBF) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  try{ return new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
  catch(e){ return new TextDecoder("shift_jis").decode(bytes); }
}

/* CSV を行（文字列の配列）の配列にする。ダブルクォート・""（引用符そのもの）・フィールド内のカンマと改行を扱う */
function wcParseCsv(text){
  var rows=[], row=[], cell="", q=false, i=0, n=text.length, started=false;
  function endCell(){ row.push(cell); cell=""; started=false; }
  function endRow(){
    endCell();
    if(rows.length>=WC_MAX_ROWS+50) throw new Error("行が多すぎます（"+WC_MAX_ROWS+"行まで）");
    rows.push(row); row=[];
  }
  while(i<n){
    var c=text.charAt(i);
    if(q){
      if(c==='"'){
        if(text.charAt(i+1)==='"'){ cell+='"'; i+=2; continue; }
        q=false; i++; continue;
      }
      cell+=c; i++; continue;
    }
    if(c==='"' && !started){ q=true; started=true; i++; continue; }
    if(c===","){ endCell(); i++; continue; }
    if(c==="\r"){ if(text.charAt(i+1)==="\n") i++; endRow(); i++; continue; }
    if(c==="\n"){ endRow(); i++; continue; }
    cell+=c; started=true; i++;
  }
  if(started || cell!=="" || row.length) endRow();
  return rows;
}

/* 同じ項目かの判定に使う文字の正規化（全角・半角のゆれと、空白の数の違いを吸収する） */
function wcNorm(s){
  s=String(s==null?"":s);
  if(s.normalize) s=s.normalize("NFKC");
  return s.replace(/\s+/g," ").trim();
}
/* 同一の判定キー：「コース名（ID つき）＋教材名」 */
function wcKey(course,title){ return wcNorm(course)+"\n"+wcNorm(title); }
/* キーのハッシュ（16桁の16進）。除外リストには教材名・コース名そのものを残さず、これだけを保存する */
function wcHash(s){
  var h1=0x811c9dc5, h2=0x01000193^s.length;
  for(var i=0;i<s.length;i++){
    var c=s.charCodeAt(i);
    h1=Math.imul(h1^c,0x01000193);
    h2=Math.imul(h2^c,0x85ebca6b); h2^=h2>>>13;
  }
  function hex(v){ return ("0000000"+(v>>>0).toString(16)).slice(-8); }
  return hex(h1)+hex(h2);
}

/* コース名の末尾の「(202611099028010201)」のような ID。授業のコースには付き、調査・手続きなどには付かない */
var WC_COURSE_ID=/\s*[(（][0-9A-Za-z]{12,}[)）]\s*$/;
function wcCourseName(course){ return String(course||"").replace(WC_COURSE_ID,"").trim(); }

/* 「YYYY-MM-DD HH:MM」を日本時間として読む。実在しない日時・形が違うものは null */
function wcParseDue(s){
  var m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(s||"").trim());
  if(!m) return null;
  var y=+m[1], mo=+m[2], d=+m[3], hh=+m[4], mi=+m[5];
  var t=new Date(Date.UTC(y,mo-1,d,hh-9,mi));
  var j=new Date(t.getTime()+9*3600000); // 日本時間の暦に戻して、丸められていないか確かめる
  if(j.getUTCFullYear()!==y || j.getUTCMonth()!==mo-1 || j.getUTCDate()!==d || j.getUTCHours()!==hh || j.getUTCMinutes()!==mi) return null;
  return t;
}

/* CSV の文字列を、締切の候補の配列にする。
   返り値：{entries:[…], skipped: 読めなかった行の数}
   entry：{key, hash, course（ID つき）, courseName（ID なし）, title, due（Date か null）, dueText, status,
           submitted（提出済み）, selfStudy（自習用）, optional（受講任意）, nonClass（授業以外）, noDue（締切なし）} */
function wcParse(text){
  var rows=wcParseCsv(text), head=-1, idx={};
  for(var r=0;r<rows.length && head<0;r++){
    var cells=rows[r].map(function(c){ return c.trim(); });
    if(WC_COLS.every(function(name){ return cells.indexOf(name)>=0; })){
      head=r; WC_COLS.forEach(function(name){ idx[name]=cells.indexOf(name); });
    }
  }
  if(head<0) throw new Error("WebClass の成績表ではないようです（見出しの行が見つかりません）");
  var entries=[], seen={}, skipped=0;
  for(var k=head+1;k<rows.length;k++){
    var row=rows[k];
    if(row.length===1 && row[0].trim()==="") continue; // 空行
    if(entries.length>=WC_MAX_ROWS) throw new Error("行が多すぎます（"+WC_MAX_ROWS+"行まで）");
    var get=function(name){ var v=row[idx[name]]; return v==null?"":String(v).trim(); };
    var course=get("コース名"), title=get("教材");
    if(!course || !title){ skipped++; continue; }
    var key=wcKey(course,title);
    if(seen[key]){ skipped++; continue; } // 同じコースの同じ教材名が2回出たら、先の1件だけ
    seen[key]=1;
    var dueText=get("締切"), due=dueText?wcParseDue(dueText):null;
    var status=get("状態"), done=get("実施日");
    entries.push({
      key:key, hash:wcHash(key), course:course, courseName:wcCourseName(course), title:title,
      due:due, dueText:dueText, status:status,
      // 提出済み：状態が「回答済み」、または実施日に日時が入っている（状態が「-」の宿題・小テストなど）
      submitted: status==="回答済み" || /^\d{4}-\d{2}-\d{2}/.test(done),
      selfStudy: title.indexOf("自習用")>=0,
      optional: get("学科").indexOf("任意")>=0 || course.indexOf("任意")>=0,
      nonClass: !WC_COURSE_ID.test(course),
      noDue: !due
    });
  }
  return {entries:entries, skipped:skipped};
}

/* プレビューに出す目印（文字）。now は今の時刻（Date） */
function wcFlags(e,now){
  var f=[];
  if(e.noDue) f.push("締切なし");
  else if(!e.submitted && e.due<now) f.push("期限切れ");
  if(e.submitted) f.push("提出済み");
  if(e.selfStudy) f.push("自習用");
  if(e.optional) f.push("任意");
  if(e.nonClass) f.push("授業以外");
  return f;
}
/* 最初から選んでおくか：未提出・締切がこれから・自習用でも任意でもないもの */
function wcDefaultSelected(e,now){
  return !e.noDue && !e.submitted && !e.selfStudy && !e.optional && e.due>=now;
}

/* 候補1件を、締切の項目にする（締切なしは null）。id と今の時刻は呼び出し側が渡す。
   題名は 80字まで。超えた分は切り、全文をメモの先頭に入れる。最高点（成績）・学部・学科は保存しない */
function wcToItem(e,id,now){
  if(!e.due) return null;
  var title=e.title, memo="コース："+e.courseName;
  if(title.length>WC_TITLE_MAX){ memo=title+"\n"+memo; title=title.slice(0,WC_TITLE_MAX-1)+"…"; }
  return {id:id, title:title, due:e.due.toISOString(), cat:WC_CAT, rep:"none", repCount:0, memo:memo, done:false,
          created:now.toISOString(), wc:e.key};
}

/* ---- 除外リスト（選ばなかった項目。次回のプレビューに出さない） ----
   1件は {k: キーのハッシュ, due: 除外したときの締切の文字（空欄なら ""）, at: 除外した日 "YYYY-MM-DD"}。
   教材名・コース名そのものは保存しない（履修の情報のため）。同期するデータに入れる */
var WC_EXCLUDED_MAX=5000;
function wcCleanExcluded(arr){
  if(!Array.isArray(arr)) return [];
  var by={}, order=[];
  arr.forEach(function(x){
    if(!x || typeof x!=="object" || typeof x.k!=="string" || !/^[0-9a-f]{16}$/.test(x.k)) return;
    var due=typeof x.due==="string" && x.due.length<=20 ? x.due : "";
    var at=typeof x.at==="string" && /^\d{4}-\d{2}-\d{2}$/.test(x.at) ? x.at : "";
    if(!(x.k in by)) order.push(x.k);
    by[x.k]={k:x.k, due:due, at:at}; // 同じキーは後のものを使う
  });
  var out=order.map(function(k){ return by[k]; });
  return out.length>WC_EXCLUDED_MAX ? out.slice(out.length-WC_EXCLUDED_MAX) : out; // 多すぎたら古いものから捨てる
}

/* プレビューの行を作る。items は今の締切、excluded は除外リスト、now は今の時刻。
   各行：{e: 候補, state, item（締切が変わった既存の締切）, selected（最初から選ぶか）}
   state：new（新しい）／changed（登録済みで締切だけ変わった）／excluded（除外済みで締切も同じ。登録済みで締切の変更を見送ったものは item つき）／
   registered（登録済みで同じ。出さない） */
function wcPlan(entries, items, excluded, now){
  var byKey={}, ex={};
  (items||[]).forEach(function(it){ if(it && typeof it.wc==="string") byKey[it.wc]=it; }); // wc は wcKey で作ったキーそのもの
  (excluded||[]).forEach(function(x){ ex[x.k]=x; });
  return entries.map(function(e){
    var it=byKey[e.key];
    var x=ex[e.hash], declined=!!(x && x.due===e.dueText); // 除外したときと締切が同じ
    if(it){
      if(!e.due || Date.parse(it.due)===e.due.getTime()) return {e:e, state:"registered", item:it, selected:false};
      // 締切の変更を一度見送ったもの（同じ締切のまま）は、除外済みとして隠す。選べば既存の締切を更新する
      if(declined) return {e:e, state:"excluded", item:it, selected:false};
      return {e:e, state:"changed", item:it, selected:!e.submitted && e.due>=now};
    }
    if(declined) return {e:e, state:"excluded", item:null, selected:false};
    return {e:e, state:"new", item:null, selected:wcDefaultSelected(e,now)};
  });
}

root.DTWebClass={WC_CAT:WC_CAT, WC_COLS:WC_COLS, WC_MAX_BYTES:WC_MAX_BYTES, WC_MAX_ROWS:WC_MAX_ROWS,
  wcDecode:wcDecode, wcParseCsv:wcParseCsv, wcNorm:wcNorm, wcKey:wcKey, wcHash:wcHash, wcCourseName:wcCourseName,
  wcParseDue:wcParseDue, wcParse:wcParse, wcFlags:wcFlags, wcDefaultSelected:wcDefaultSelected, wcToItem:wcToItem,
  WC_EXCLUDED_MAX:WC_EXCLUDED_MAX, wcCleanExcluded:wcCleanExcluded, wcPlan:wcPlan};
})(typeof window!=="undefined"?window:this);
