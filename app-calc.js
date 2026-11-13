/* 画面・保存・通信に触れない計算（日付・繰り返し・全角→半角）。app.js から切り出した（docs/IMPROVEMENTS.md の 40）。
   theme-boot.js と同じく即時関数の中で定義し、DTCalc の1つの名前だけを外に出す。app.js は先頭で受け取り、今までどおりの名前で使う。
   テストは test/support/appFns.js がこのファイルを vm で読み、DTCalc から取り出す。関数の中身は app.js にあったときのまま */
(function(root){
"use strict";
function pad(n){ return (n<10?"0":"")+n; }

function toLocalISO(d){ return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }

function startOfDay(d){ return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }

function daysBetween(a,b){ return Math.round((startOfDay(b)-startOfDay(a))/86400000); }

function parseItemDate(it){ return new Date(it.due); }

/* 残り日数の基準になる日時。期間つきの予定は「開始日」までを数える */
function refDate(it){ return it.start?new Date(it.start):parseItemDate(it); }

function isRepeating(it){ return !!(it.rep&&it.rep!=="none"); }

/* 月・年単位の繰り返しの基準日（何日の予定か） */
function anchorDayOf(it){ return it.repDay || parseItemDate(it).getDate(); }

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

/* nextOccurrence の逆。ひとつ前の回（月・年は基準日を保ち、その月に無い日は月末に丸める） */
function prevOccurrence(d, rep, anchorDay){
  var n=new Date(d);
  if(rep==="weekly") n.setDate(d.getDate()-7);
  else if(rep==="biweekly") n.setDate(d.getDate()-14);
  else if(rep==="monthly"||rep==="yearly"){
    var y=d.getFullYear()-(rep==="yearly"?1:0), m=d.getMonth()-(rep==="monthly"?1:0);
    var last=new Date(y,m+1,0).getDate();
    n=new Date(y,m,Math.min(anchorDay||d.getDate(),last),d.getHours(),d.getMinutes(),d.getSeconds());
  }
  return n;
}

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

function toHalfWidth(s){
  return s.replace(/[０-９Ａ-Ｚａ-ｚ：／＃]/g,function(c){ return String.fromCharCode(c.charCodeAt(0)-0xFEE0); }).replace(/\u3000/g," ");
}

/* ---- カテゴリーのアイコン（画像は端末内で 64px に縮小し、data URL の文字列として同期するデータに入れる） ---- */
var ICON_PX=64;
/* 1個の上限。画像 約8KB を base64 にした長さ＋先頭の「data:image/…;base64,」。Worker（worker/src/index.js）も同じ値で確かめる */
var ICON_MAX_CHARS=11000;
var ICON_RE=/^data:image\/(?:png|webp);base64,[A-Za-z0-9+\/]+=*$/;
/* アイコンとして保存できる値か。PNG・WebP の data URL で、上限以下のものだけ（SVG は中にスクリプトを持てるので通さない） */
function isIconData(v){ return typeof v==="string" && v.length<=ICON_MAX_CHARS && ICON_RE.test(v); }
/* カテゴリー名→アイコン の入れ物を検査して作り直す。壊れた値・大きすぎる値は捨てる。
   categories（名前の配列）を渡すと、そこに無い名前のアイコンも捨てる */
function cleanCatIcons(o, categories){
  var out=Object.create(null); if(!o||typeof o!=="object"||Array.isArray(o)) return out;
  Object.keys(o).forEach(function(k){
    if(categories && categories.indexOf(k)<0) return;
    if(isIconData(o[k])) out[k]=o[k];
  });
  return out;
}
/* 元の画像（幅 w・高さ h）から、中央の正方形を切り抜く範囲 */
function iconCropRect(w,h){
  var side=Math.min(w,h);
  return {sx:Math.floor((w-side)/2), sy:Math.floor((h-side)/2), side:side};
}
/* 縮小した画像を文字列にする。toData(type,quality) は canvas.toDataURL と同じ形の関数。
   WebP で画質を下げながら上限に収まるものを探し、WebP を書き出せないブラウザ（PNG が返る）では PNG を試す。収まらなければ null */
function encodeIcon(toData){
  var qs=[.9,.75,.6,.45,.3];
  for(var i=0;i<qs.length;i++){
    var v=toData("image/webp",qs[i]);
    if(typeof v!=="string" || v.indexOf("data:image/webp")!==0) break; // WebP を書き出せない
    if(isIconData(v)) return v;
  }
  var png=toData("image/png");
  return isIconData(png) ? png : null;
}

root.DTCalc={pad, toLocalISO, startOfDay, daysBetween, parseItemDate, refDate, isRepeating, anchorDayOf, nextOccurrence, prevOccurrence, advanceRepeating, expandOccurrences, monthEndRule, toHalfWidth, ICON_PX, ICON_MAX_CHARS, isIconData, cleanCatIcons, iconCropRect, encodeIcon};
})(typeof window!=="undefined"?window:this);
