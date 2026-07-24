import qrcode from "qrcode-generator";

// Renders `data` as a scalable inline QR code SVG string. Type number 0 lets the library pick the
// smallest QR version that fits the data; "M" (~15% error correction) matches what MetaMask/Phantom
// use for address QR codes -- enough to survive a scuffed phone-camera scan without bloating the
// module count for a ~64-char address.
export function qrCodeSvg(data: string): string {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}
