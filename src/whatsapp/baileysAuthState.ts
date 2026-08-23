import { Mutex } from "async-mutex";
import { proto } from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON, type AuthenticationState } from "@whiskeysockets/baileys";
import { prisma } from "../db/prisma.js";
import { encryptToken, decryptToken } from "../config/crypto.js";

// Equivalente a useMultiFileAuthState() do próprio Baileys, mas guardando
// tudo (creds + chaves do protocolo Signal) num único blob JSON
// criptografado na coluna `baileysAuthState`, em vez de um arquivo por
// chave — os containers da VPS são recriados a cada deploy (sem volume
// persistente), então salvar em disco local perderia a sessão toda vez e
// forçaria escanear o QR de novo. Um blob único é uma simplificação segura
// aqui: o volume de chaves do Signal por tenant é pequeno (uma sessão por
// contato, não por mensagem), diferente de multi-file que existe só pra
// paralelizar I/O de disco.
interface StoredState {
  creds: unknown;
  keys: Record<string, Record<string, unknown>>;
}

// Serializa/deserializa com o replacer/reviver do próprio Baileys
// (BufferJSON) — as chaves do Signal contêm Buffer/Uint8Array que o
// JSON.stringify normal corrompe silenciosamente.
async function loadStored(accountId: string): Promise<StoredState> {
  const account = await prisma.tenantWhatsappAccount.findUnique({
    where: { id: accountId },
    select: { baileysAuthState: true },
  });

  if (!account?.baileysAuthState) {
    return { creds: initAuthCreds(), keys: {} };
  }

  return JSON.parse(decryptToken(account.baileysAuthState), BufferJSON.reviver);
}

async function persistStored(accountId: string, data: StoredState): Promise<void> {
  const serialized = JSON.stringify(data, BufferJSON.replacer);
  await prisma.tenantWhatsappAccount.update({
    where: { id: accountId },
    data: { baileysAuthState: encryptToken(serialized) },
  });
}

// Uma única sessão Baileys por tenant, mas creds.update e keys.set podem
// disparar em sequência rápida (ex: durante o pareamento inicial) — sem
// trava, um write-after-read fora de ordem pode sobrescrever uma chave
// recém-salva com um estado mais velho.
const tenantLocks = new Map<string, Mutex>();
function lockFor(accountId: string): Mutex {
  let mutex = tenantLocks.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    tenantLocks.set(accountId, mutex);
  }
  return mutex;
}

export async function usePostgresAuthState(
  accountId: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const stored = await loadStored(accountId);
  const creds = stored.creds as AuthenticationState["creds"];
  const keys = stored.keys;

  const persist = () => lockFor(accountId).runExclusive(() => persistStored(accountId, { creds, keys }));

  return {
    state: {
      creds,
      keys: {
        // As chaves do Signal cobrem vários formatos (Uint8Array, mapas por
        // jid, etc.) que o TS não consegue amarrar num único blob JSON
        // genérico — o próprio Baileys valida o shape em runtime.
        get: async (type, ids) => {
          const data: Record<string, unknown> = {};
          for (const id of ids) {
            let value = keys[type]?.[id];
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data as any;
        },
        set: async (data: any) => {
          for (const category in data) {
            keys[category] ??= {};
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) keys[category][id] = value;
              else delete keys[category][id];
            }
          }
          await persist();
        },
      },
    },
    saveCreds: persist,
  };
}
