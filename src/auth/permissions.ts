// Catálogo de permissões por conta (tenant). Cada usuário tem um papel
// (admin | user) que define os valores padrão, e um mapa de exceções
// (User.permissions) que liga/desliga permissões individualmente — no
// estilo do GoHighLevel. O frontend usa o mesmo catálogo (GET
// /auth/permissions) pra desenhar as chaves na tela de equipe.

export type Role = "admin" | "user";

export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  description?: string;
  // Só pode ser ligada pra admin — pra "user" fica sempre desligada e nem
  // aparece como opção.
  adminOnly?: boolean;
  // Permissão "restritiva": ligada = vê menos. O padrão de user é ligada.
  restriction?: boolean;
  defaults: Record<Role, boolean>;
}

const both = { admin: true, user: true };
const adminOnly = { admin: true, user: false };

export const PERMISSIONS: PermissionDef[] = [
  { key: "dashboard.view", group: "Dashboard", label: "Ver dashboard", defaults: both },
  {
    key: "dashboard.view_team",
    group: "Dashboard",
    label: "Ver métricas da equipe toda",
    description: "Desligado: o dashboard mostra só os números do próprio usuário.",
    defaults: adminOnly,
  },

  { key: "conversations.view", group: "Conversas", label: "Ver e responder conversas", defaults: both },
  {
    key: "conversations.only_assigned",
    group: "Conversas",
    label: "Ver só conversas atribuídas a ele (e as sem responsável)",
    restriction: true,
    defaults: { admin: false, user: true },
  },
  { key: "conversations.transfer", group: "Conversas", label: "Transferir conversa para outra pessoa", defaults: adminOnly },
  { key: "conversations.start", group: "Conversas", label: "Iniciar conversa com contato novo", defaults: both },

  { key: "contacts.view", group: "Contatos", label: "Ver contatos", defaults: both },
  { key: "contacts.edit", group: "Contatos", label: "Criar e editar contatos (inclusive etiquetas)", defaults: both },

  { key: "deals.view", group: "Oportunidades", label: "Ver oportunidades", defaults: both },
  {
    key: "deals.only_assigned",
    group: "Oportunidades",
    label: "Ver só oportunidades atribuídas a ele (e as sem responsável)",
    restriction: true,
    defaults: { admin: false, user: true },
  },
  { key: "deals.edit", group: "Oportunidades", label: "Criar, editar e mover oportunidades", defaults: both },
  { key: "deals.delete", group: "Oportunidades", label: "Excluir oportunidades", defaults: adminOnly },
  { key: "pipelines.manage", group: "Oportunidades", label: "Criar e editar pipelines e estágios", defaults: adminOnly },
  { key: "custom_fields.manage", group: "Oportunidades", label: "Gerenciar campos personalizados", defaults: adminOnly },

  {
    key: "tasks.view_all",
    group: "Tarefas e agenda",
    label: "Ver tarefas e agenda de todos",
    description: "Desligado: vê só as próprias e as sem responsável.",
    defaults: adminOnly,
  },
  { key: "tasks.assign_others", group: "Tarefas e agenda", label: "Atribuir tarefas e eventos a outras pessoas", defaults: adminOnly },

  { key: "broadcasts.manage", group: "Disparos", label: "Criar e enviar disparos", defaults: adminOnly },

  { key: "automations.view", group: "Automações", label: "Ver automações e registros", defaults: adminOnly },
  { key: "automations.manage", group: "Automações", label: "Criar, editar e ativar automações", defaults: adminOnly },
  { key: "chatbot.manage", group: "Automações", label: "Gerenciar chatbot", defaults: adminOnly },

  { key: "quick_replies.manage", group: "Configurações", label: "Gerenciar respostas rápidas", defaults: adminOnly },
  { key: "tags.manage", group: "Configurações", label: "Renomear e apagar etiquetas", defaults: adminOnly },
  { key: "data.export", group: "Configurações", label: "Exportar dados (CSV)", defaults: adminOnly },

  {
    key: "whatsapp.manage",
    group: "Administração",
    label: "Conectar e desconectar o WhatsApp",
    adminOnly: true,
    defaults: adminOnly,
  },
  {
    key: "users.manage",
    group: "Administração",
    label: "Gerenciar usuários e permissões",
    description: "Sempre ligado pra admin — evita uma conta ficar sem ninguém pra gerenciar a equipe.",
    adminOnly: true,
    defaults: adminOnly,
  },
];

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function isPermissionKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function normalizeRole(role: string): Role {
  return role === "admin" ? "admin" : "user";
}

// Papel + exceções salvas → conjunto final de permissões ligadas.
export function resolvePermissions(roleInput: string, overrides: unknown): Set<string> {
  const role = normalizeRole(roleInput);
  const custom = overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>) : {};
  const granted = new Set<string>();

  for (const perm of PERMISSIONS) {
    if (perm.adminOnly && role !== "admin") continue;
    if (perm.key === "users.manage" && role === "admin") {
      granted.add(perm.key);
      continue;
    }
    const value = typeof custom[perm.key] === "boolean" ? (custom[perm.key] as boolean) : perm.defaults[role];
    if (value) granted.add(perm.key);
  }
  return granted;
}

// Só guarda o que difere do padrão do papel — assim, mudar um padrão no
// catálogo vale pra todo mundo que não personalizou aquela chave.
export function compactOverrides(roleInput: string, values: Record<string, boolean>): Record<string, boolean> {
  const role = normalizeRole(roleInput);
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    const perm = BY_KEY.get(key);
    if (!perm) continue;
    if (perm.adminOnly && role !== "admin") continue;
    if (value !== perm.defaults[role]) result[key] = value;
  }
  return result;
}

// Chaves que a agência pode desligar numa conta inteira. Ficam de fora as
// "restritivas" (desligar ampliaria o acesso, não reduziria) e
// users.manage (a conta precisa de alguém que gerencie a equipe).
export function isAgencyTogglable(key: string): boolean {
  const perm = BY_KEY.get(key);
  return !!perm && !perm.restriction && perm.key !== "users.manage";
}

export function disabledPermissionList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string" && isAgencyTogglable(k)) : [];
}
