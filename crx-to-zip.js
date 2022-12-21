// based on https://github.com/Rob--W/crxviewer/blob/master/src/lib/crx-to-zip.js
// (c) 2013 Rob Wu <rob@robwu.nl>

import encLatin1 from "crypto-js/enc-latin1.js";
import sha256 from "crypto-js/sha256.js";

function calcLength(a, b, c, d) {
  let length = 0;
  length += a << 0; // eslint-disable-line unicorn/prefer-math-trunc
  length += b << 8;
  length += c << 16;
  length += d << 24 >>> 0;
  return length;
}
function getBinaryString(bytesView, startOffset, endOffset) {
  let binaryString = "";
  for (let i = startOffset; i < endOffset; ++i) {
    binaryString += String.fromCharCode(bytesView[i]);
  }
  return binaryString;
}

// Strips CRX headers from zip
export default function CRXtoZIP(arraybuffer) {
  // Definition of crx format: http://developer.chrome.com/extensions/crx.html
  const view = new Uint8Array(arraybuffer);

  // 50 4b 03 04
  if (view[0] === 80 && view[1] === 75 && view[2] === 3 && view[3] === 4) {
    throw new Error("Input is not a CRX file, but a ZIP file.");
  }

  // 43 72 32 34
  if (view[0] !== 67 || view[1] !== 114 || view[2] !== 50 || view[3] !== 52) {
    if (isMaybeZipData(view)) {
      throw new Error("Input is not a CRX file, but possibly a ZIP file.");
    }
    throw new Error("Invalid header: Does not start with Cr24.");
  }

  // 02 00 00 00
  // 03 00 00 00 CRX3
  if (view[4] !== 2 && view[4] !== 3 || view[5] || view[6] || view[7]) {
    throw new Error("Unexpected crx format version number.");
  }

  let zipStartOffset, _publicKeyBase64;
  if (view[4] === 2) {
    const publicKeyLength = calcLength(view[8], view[9], view[10], view[11]);
    const signatureLength = calcLength(view[12], view[13], view[14], view[15]);
    // 16 = Magic number (4), CRX format version (4), lengths (2x4)
    zipStartOffset = 16 + publicKeyLength + signatureLength;

    // Public key
    _publicKeyBase64 = btoa(getBinaryString(view, 16, 16 + publicKeyLength));
  } else { // view[4] === 3
    // CRX3 - https://cs.chromium.org/chromium/src/components/crx_file/crx3.proto
    const crx3HeaderLength = calcLength(view[8], view[9], view[10], view[11]);
    // 12 = Magic number (4), CRX format version (4), header length (4)
    zipStartOffset = 12 + crx3HeaderLength;

    // Public key
    _publicKeyBase64 = getPublicKeyFromProtoBuf(view, 12, zipStartOffset);
  }

  return arraybuffer.slice(zipStartOffset);
}

function getPublicKeyFromProtoBuf(bytesView, startOffset, endOffset) {
  // Protobuf definition: https://cs.chromium.org/chromium/src/components/crx_file/crx3.proto
  // Wire format: https://developers.google.com/protocol-buffers/docs/encoding
  // The top-level CrxFileHeader message only contains length-delimited fields (type 2).
  // To find the public key:
  // 1. Look for CrxFileHeader.sha256_with_rsa (field number 2).
  // 2. Look for AsymmetricKeyProof.public_key (field number 1).
  // 3. Look for CrxFileHeader.signed_header_data (SignedData.crx_id).
  //    This has 16 bytes (128 bits). Verify that those match with the
  //    first 128 bits of the sha256 hash of the chosen public key.

  function getvarint() {
    // Note: We don't do bound checks (startOffset < endOffset) here,
    // because even if we read past the end of bytesView, then we get
    // the undefined value, which is converted to 0 when we do a
    // bitwise operation in JavaScript.
    let val = bytesView[startOffset] & 0x7F;
    if (bytesView[startOffset++] < 0x80) return val;
    val |= (bytesView[startOffset] & 0x7F) << 7;
    if (bytesView[startOffset++] < 0x80) return val;
    val |= (bytesView[startOffset] & 0x7F) << 14;
    if (bytesView[startOffset++] < 0x80) return val;
    val |= (bytesView[startOffset] & 0x7F) << 21;
    if (bytesView[startOffset++] < 0x80) return val;
    val = (val | (bytesView[startOffset] & 0xF) << 28) >>> 0;
    if (bytesView[startOffset++] & 0x80) throw new Error("proto: not a uint32");
    return val;
  }

  const publicKeys = [];
  let crxIdBin;
  while (startOffset < endOffset) {
    const key = getvarint();
    const length = getvarint();
    if (key === 80002) { // This is ((10000 << 3) | 2) (signed_header_data).
      const sigdatakey = getvarint();
      const sigdatalen = getvarint();
      if (sigdatakey !== 0xA) {
        throw new Error(`proto: Unexpected key in signed_header_data: ${sigdatakey}`);
      } else if (sigdatalen !== 16) {
        throw new Error(`proto: Unexpected signed_header_data length ${length}`);
      } else if (crxIdBin) {
        throw new Error("proto: Unexpected duplicate signed_header_data");
      } else {
        crxIdBin = bytesView.subarray(startOffset, startOffset + 16);
      }
      startOffset += sigdatalen;
      continue;
    }
    if (key !== 0x12) {
      // Likely 0x1a (sha256_with_ecdsa).
      if (key !== 0x1A) {
        throw new Error(`proto: Unexpected key: ${key}`);
      }
      startOffset += length;
      continue;
    }
    // Found 0x12 (sha256_with_rsa); Look for 0xA (public_key).
    const keyproofend = startOffset + length;
    let keyproofkey = getvarint();
    let keyprooflength = getvarint();
    // AsymmetricKeyProof could contain 0xA (public_key) or 0x12 (signature).
    if (keyproofkey === 0x12) {
      startOffset += keyprooflength;
      if (startOffset >= keyproofend) {
        // signature without public_key...? The protocol definition allows it...
        continue;
      }
      keyproofkey = getvarint();
      keyprooflength = getvarint();
    }
    if (keyproofkey !== 0xA) {
      startOffset += keyprooflength;
      throw new Error(`proto: Unexpected key in AsymmetricKeyProof: ${keyproofkey}`);
    }
    if (startOffset + keyprooflength > endOffset) {
      throw new Error("proto: size of public_key field is too large");
    }
    // Found 0xA (public_key).
    publicKeys.push(getBinaryString(bytesView, startOffset, startOffset + keyprooflength));
    startOffset = keyproofend;
  }
  if (!publicKeys.length) {
    throw new Error("proto: Did not find any public key");
  }
  if (!crxIdBin) {
    throw new Error("proto: Did not find crx_id");
  }
  const crxIdHex = encLatin1.parse(getBinaryString(crxIdBin, 0, 16)).toString();
  for (let i = 0; i < publicKeys.length; ++i) {
    const sha256sum = sha256(encLatin1.parse(publicKeys[i])).toString();
    if (sha256sum.slice(0, 32) === crxIdHex) {
      return btoa(publicKeys[i]);
    }
  }
  throw new Error("proto: None of the public keys matched with crx_id");
}
function isMaybeZipData(view) {
  // Find EOCD (0xFFFF is the maximum size of an optional trailing comment).
  for (let i = view.length - 22, ii = Math.max(0, i - 0xFFFF); i >= ii; --i) {
    if (view[i] === 0x50 && view[i + 1] === 0x4B &&
      view[i + 2] === 0x05 && view[i + 3] === 0x06) {
      return true;
    }
  }

  return false;
}
