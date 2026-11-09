/* テーマを、画面を描く前に決める（ちらつきを防ぐ）。<head> で styles.css の直前に読む。
   CSP（script-src 'self'）で <head> に直接スクリプトを書けないため、小さな別ファイルにしている。
   選んだテーマはこの端末のブラウザ（localStorage）にだけ保存する。同期しない。 */
(function(root){
  var THEMES=["matcha","stone","dark"];
  var THEME_NAMES={matcha:"抹茶",stone:"石",dark:"墨"};
  var KEY="deadline-tracker-theme";

  function prefersDark(){
    try{ return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches); }catch(e){ return false; }
  }
  /* 保存された値と端末の設定から、使うテーマを決める。まだ選んでいない（または3つ以外の値）なら、端末がダークなら墨、それ以外は抹茶 */
  function resolveTheme(saved,dark){
    return THEMES.indexOf(saved)>=0 ? saved : (dark ? "dark" : "matcha");
  }
  function readSavedTheme(){
    try{
      var v=root.localStorage.getItem(KEY);
      return THEMES.indexOf(v)>=0 ? v : null;
    }catch(e){ return null; }
  }
  function saveTheme(name){
    if(THEMES.indexOf(name)<0) return false;
    try{ root.localStorage.setItem(KEY,name); return true; }catch(e){ return false; }
  }
  function bootTheme(){
    var t=resolveTheme(readSavedTheme(),prefersDark());
    try{ root.document.documentElement.setAttribute("data-theme",t); }catch(e){}
    return t;
  }

  root.THEMES=THEMES; root.THEME_NAMES=THEME_NAMES;
  root.resolveTheme=resolveTheme; root.readSavedTheme=readSavedTheme; root.saveTheme=saveTheme; root.bootTheme=bootTheme; root.themePrefersDark=prefersDark;
  bootTheme();
})(typeof window!=="undefined"?window:this);
