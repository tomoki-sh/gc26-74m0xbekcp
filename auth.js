/* Googleログイン（2人用）。閲覧専用の人には読み込まれないよう、app.js から必要なときだけ import する。
   apiKey 等は公開してよい識別子。保護は、許可したアカウントだけを通すDBルールで行う。 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider, browserLocalPersistence, setPersistence, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCeN_PFTYk0VSLitM8_S7YSJelYjqSkIzM",
  authDomain: "travel-itinerary-sites.firebaseapp.com",
  databaseURL: "https://travel-itinerary-sites-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "travel-itinerary-sites",
  storageBucket: "travel-itinerary-sites.firebasestorage.app",
  messagingSenderId: "933681618085",
  appId: "1:933681618085:web:8b59a29239aaecfaec414c"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
window.FB = { db: getDatabase(app), ref, onValue, set };

const loginButton = document.getElementById("gate-sign-in");
const logoutButtons = [document.getElementById("auth-sign-out"), document.getElementById("gate-sign-out")];
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
// 既定でローカル保存。await はログインボタンの前に挟まない（iOS Safari で「押した直後」でないとポップアップが開けないため）
setPersistence(auth, browserLocalPersistence).catch(() => { /* 保存できない環境でもログインは試す */ });

const LOGIN_ERRORS = {
  "auth/popup-blocked": "ポップアップが開けませんでした。もう一度ボタンを押すか、ブラウザの設定でポップアップを許可してください。",
  "auth/network-request-failed": "通信できませんでした。電波の良い場所でもう一度お試しください。",
  "auth/web-storage-unsupported": "このブラウザではログインできません。Safari や Chrome で開いてください（プライベートブラウズは避けてください）。",
  "auth/operation-not-supported-in-this-environment": "このブラウザではログインできません。Safari や Chrome で開いてください。"
};

export function signIn() {
  if (!loginButton) return;
  loginButton.disabled = true;
  // クリックした流れのまま開く（間に await を入れない）
  signInWithPopup(auth, provider)
    .catch(e => {
      const code = e && e.code;
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      window.Catalog.setStatus(LOGIN_ERRORS[code] || "ログインできませんでした。もう一度ボタンを押してみてください。", "error");
    })
    .finally(() => { loginButton.disabled = false; });
}
if (loginButton) loginButton.addEventListener("click", signIn);

logoutButtons.forEach(b => b && b.addEventListener("click", async () => {
  if (!confirm("ログアウトしますか？（この端末に残した控えと、記憶した鍵も消します）")) return;
  await signOut(auth);
  window.Catalog.clearCache();
  location.reload();
}));

onAuthStateChanged(auth, user => {
  const g = user && !user.isAnonymous ? user : null;
  if (loginButton) loginButton.hidden = !!g;
  logoutButtons.forEach(b => { if (b) b.hidden = !g; });
  window.Catalog.onAuth(g ? g.uid : "", g ? g.email : "");
});
