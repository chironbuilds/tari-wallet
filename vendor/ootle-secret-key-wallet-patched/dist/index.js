var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { addTransactionSigner as e, generateKeypair as t, generateOotleAddress as n, generateOotleSecretKey as r, ootlePublicKeyFromSecretKey as i, publicKeyFromSecretKey as a } from "@tari-project/ootle-wasm";
import { Network as o, WalletError as s, assertByteLength as c, serializeUnsignedTx as l } from "@tari-project/ootle";
var u = class t2 {
  constructor(e2, t3, n2, r3, i2) {
    __publicField(this, "ownerSecretKey");
    __publicField(this, "ownerPublicKey");
    __publicField(this, "viewOnlySecret");
    __publicField(this, "viewOnlyPublicKey");
    __publicField(this, "network");
    this.ownerSecretKey = e2, this.ownerPublicKey = t3, this.viewOnlySecret = r3 ?? null, this.viewOnlyPublicKey = i2 ?? null, this.network = n2;
  }
  static randomWithViewKey(e2) {
    let n2 = r(), a2 = i(n2.owner_key, n2.view_key);
    return new t2(n2.owner_key, a2.owner_key, e2, n2.view_key, a2.view_key);
  }
  static fromSecretKey(e2, n2, r3) {
    c(e2, 32, "SecretKeyWallet.fromSecretKey ownerSecretKey"), r3 !== void 0 && c(r3, 32, "SecretKeyWallet.fromSecretKey viewOnlySecret");
    let o2 = a(e2), s2 = r3 === void 0 ? null : i(e2, r3).view_key;
    return new t2(e2, o2, n2, r3 ?? null, s2);
  }
  static fromKeypair(e2, n2, r3, a2) {
    c(e2, 32, "SecretKeyWallet.fromKeypair ownerSecretKey"), c(n2, 32, "SecretKeyWallet.fromKeypair ownerPublicKey"), a2 !== void 0 && c(a2, 32, "SecretKeyWallet.fromKeypair viewOnlySecret");
    let o2 = a2 === void 0 ? null : i(e2, a2).view_key;
    return new t2(e2, n2, r3, a2 ?? null, o2);
  }
  async getAddress() {
    if (!this.viewOnlyPublicKey) throw new s("View-only key not set. Construct the wallet via SecretKeyWallet.randomWithViewKey(), or pass a `viewOnlySecret` to SecretKeyWallet.fromKeypair() / SecretKeyWallet.fromSecretKey().");
    let e2 = n(this.ownerPublicKey, this.viewOnlyPublicKey, this.network);
    return Promise.resolve(e2);
  }
  async getPublicKey() {
    return Promise.resolve(this.ownerPublicKey);
  }
  getViewOnlySecret() {
    return this.viewOnlySecret;
  }
  async getViewSecret() {
    let e2 = this.getViewOnlySecret();
    if (!e2) throw new s("No view-only secret set on this wallet. Create it via SecretKeyWallet.randomWithViewKey(), or pass a view secret to fromSecretKey()/fromKeypair().");
    return e2;
  }
  async addStealthSignature(t3, n2, r3, i2) {
    let a2 = e(t3, await i2.crypto.stealthDhSecret(this.network, this.ownerSecretKey, n2), r3), o2 = JSON.parse(a2);
    return o2.signatures[o2.signatures.length - 1];
  }
  async signTransaction(t3, n2) {
    c(n2, 32, "SecretKeyWallet.signTransaction sealPublicKey");
    let r3 = e(l(t3), this.ownerSecretKey, n2);
    return JSON.parse(r3).signatures;
  }
}, d = class r2 {
  constructor(e2, r3, i2) {
    __publicField(this, "secretKey");
    __publicField(this, "publicKey");
    __publicField(this, "address");
    this.secretKey = e2, this.publicKey = r3, this.address = n(r3, t().public_key, i2);
  }
  static generate(e2 = o.Esmeralda) {
    let n2 = t();
    return c(n2.secret_key, 32, "EphemeralKeySigner secret_key"), c(n2.public_key, 32, "EphemeralKeySigner public_key"), new r2(n2.secret_key, n2.public_key, e2);
  }
  async getAddress() {
    return Promise.resolve(this.address);
  }
  async getPublicKey() {
    return Promise.resolve(this.publicKey);
  }
  async signTransaction(t3, n2) {
    c(n2, 32, "EphemeralKeySigner.signTransaction sealPublicKey");
    let r3 = e(l(t3), this.secretKey, n2), i2 = JSON.parse(r3);
    return Promise.resolve(i2.signatures);
  }
};
export {
  d as EphemeralKeySigner,
  u as SecretKeyWallet
};
