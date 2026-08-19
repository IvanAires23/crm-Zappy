// Normaliza o nome de uma tag pra comparação/unicidade — remove acento,
// caixa e espaços extras, sem virar um slug com hífen (tags continuam
// curtas, tipo "vip", "cliente antigo").
export function slugifyTagName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
