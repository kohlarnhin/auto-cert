import { base64ToBytes, base64url, concatBytes, utf8 } from './utils'
import { generateRsaKeyPair, privateKeyToPem, signRs256 } from './crypto'

function len(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length])
  const bytes: number[] = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value >>>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...contents: Uint8Array[]): Uint8Array {
  const body = concatBytes(...contents)
  return concatBytes(new Uint8Array([tag]), len(body.length), body)
}

function seq(...contents: Uint8Array[]): Uint8Array {
  return tlv(0x30, ...contents)
}

function set(...contents: Uint8Array[]): Uint8Array {
  return tlv(0x31, ...contents)
}

function integer(value: number): Uint8Array {
  if (value === 0) return tlv(0x02, new Uint8Array([0]))
  const bytes: number[] = []
  let current = value
  while (current > 0) {
    bytes.unshift(current & 0xff)
    current >>>= 8
  }
  if (bytes[0] & 0x80) bytes.unshift(0)
  return tlv(0x02, new Uint8Array(bytes))
}

function oid(value: string): Uint8Array {
  const parts = value.split('.').map(Number)
  const bytes: number[] = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f]
    let current = part >>> 7
    while (current > 0) {
      stack.unshift((current & 0x7f) | 0x80)
      current >>>= 7
    }
    bytes.push(...stack)
  }
  return tlv(0x06, new Uint8Array(bytes))
}

function nullValue(): Uint8Array {
  return tlv(0x05)
}

function utf8String(value: string): Uint8Array {
  return tlv(0x0c, utf8(value))
}

function octetString(value: Uint8Array): Uint8Array {
  return tlv(0x04, value)
}

function bitString(value: Uint8Array): Uint8Array {
  return tlv(0x03, concatBytes(new Uint8Array([0]), value))
}

function contextPrimitive(tag: number, value: Uint8Array): Uint8Array {
  return tlv(0x80 | tag, value)
}

function contextConstructed(tag: number, value: Uint8Array): Uint8Array {
  return tlv(0xa0 | tag, value)
}

function algorithmIdentifier(): Uint8Array {
  return seq(oid('1.2.840.113549.1.1.11'), nullValue())
}

function subjectName(commonName: string): Uint8Array {
  return seq(set(seq(oid('2.5.4.3'), utf8String(commonName))))
}

function sanExtension(domains: string[]): Uint8Array {
  const names = seq(...domains.map(domain => contextPrimitive(2, utf8(domain))))
  const extension = seq(oid('2.5.29.17'), octetString(names))
  const extensionRequest = seq(
    oid('1.2.840.113549.1.9.14'),
    set(seq(extension)),
  )
  return contextConstructed(0, extensionRequest)
}

export async function createCsr(domains: string[]): Promise<{ csrDer: Uint8Array, keyPem: string }> {
  const keyPair = await generateRsaKeyPair()
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer)
  const cri = seq(
    integer(0),
    subjectName(domains[0]),
    spki,
    sanExtension(domains),
  )
  const signature = await signRs256(keyPair.privateKey, cri)
  const csrDer = seq(cri, algorithmIdentifier(), bitString(signature))
  return {
    csrDer,
    keyPem: await privateKeyToPem(keyPair.privateKey),
  }
}

interface DerNode {
  tag: number
  start: number
  valueStart: number
  valueEnd: number
  end: number
}

function readNode(bytes: Uint8Array, start: number): DerNode {
  const tag = bytes[start]
  let offset = start + 1
  let length = bytes[offset++]
  if (length & 0x80) {
    const count = length & 0x7f
    length = 0
    for (let i = 0; i < count; i++) {
      length = (length << 8) | bytes[offset++]
    }
  }
  const valueStart = offset
  const valueEnd = valueStart + length
  return { tag, start, valueStart, valueEnd, end: valueEnd }
}

function children(bytes: Uint8Array, node: DerNode): DerNode[] {
  const result: DerNode[] = []
  let offset = node.valueStart
  while (offset < node.valueEnd) {
    const child = readNode(bytes, offset)
    result.push(child)
    offset = child.end
  }
  return result
}

function parseTime(bytes: Uint8Array, node: DerNode): Date {
  const text = new TextDecoder().decode(bytes.subarray(node.valueStart, node.valueEnd))
  if (node.tag === 0x17) {
    const yy = Number(text.slice(0, 2))
    const year = yy >= 50 ? 1900 + yy : 2000 + yy
    return new Date(Date.UTC(
      year,
      Number(text.slice(2, 4)) - 1,
      Number(text.slice(4, 6)),
      Number(text.slice(6, 8)),
      Number(text.slice(8, 10)),
      Number(text.slice(10, 12)),
    ))
  }
  return new Date(Date.UTC(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8)),
    Number(text.slice(8, 10)),
    Number(text.slice(10, 12)),
    Number(text.slice(12, 14)),
  ))
}

function firstCertificateDer(fullchainPem: string): Uint8Array | null {
  const match = fullchainPem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)
  if (!match) return null
  return base64ToBytes(match[1].replace(/\s+/g, ''))
}

export function parseCertificateExpiresAt(fullchainPem: string): string | null {
  const der = firstCertificateDer(fullchainPem)
  if (!der) return null
  try {
    const cert = readNode(der, 0)
    const certChildren = children(der, cert)
    const tbs = certChildren[0]
    const fields = children(der, tbs)
    let index = 0
    if (fields[index]?.tag === 0xa0) index++
    index += 3
    const validity = fields[index]
    const validityChildren = children(der, validity)
    const notAfter = parseTime(der, validityChildren[1])
    return notAfter.toISOString()
  } catch {
    return null
  }
}

export function csrToAcmeBase64(csrDer: Uint8Array): string {
  return base64url(csrDer)
}
