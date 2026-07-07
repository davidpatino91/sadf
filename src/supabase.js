import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. ' +
    'Crea un archivo .env con esas variables o la app funcionará sin persistencia.'
  )
}

export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'placeholder'
)

/* -------- mapeo snake_case ↔ camelCase -------- */

const filaACredito = (r) => ({
  id: r.id,
  banco: r.banco,
  numeroObligacion: r.numero_obligacion,
  descripcion: r.descripcion,
  valorDesembolsado: Number(r.valor_desembolsado),
  fechaDesembolso: r.fecha_desembolso,
  fechaVencimiento: r.fecha_vencimiento,
  plazoMeses: r.plazo_meses,
  spread: Number(r.spread),
  periodicidadIntereses: r.periodicidad_intereses,
  periodicidadCapital: r.periodicidad_capital,
  mesesGracia: r.meses_gracia,
  tipoAmortizacion: r.tipo_amortizacion,
  estado: r.estado,
  observaciones: r.observaciones,
})

const creditoAFila = (c) => ({
  id: c.id,
  banco: c.banco,
  numero_obligacion: c.numeroObligacion,
  descripcion: c.descripcion,
  valor_desembolsado: c.valorDesembolsado,
  fecha_desembolso: c.fechaDesembolso,
  fecha_vencimiento: c.fechaVencimiento,
  plazo_meses: c.plazoMeses,
  spread: c.spread,
  periodicidad_intereses: c.periodicidadIntereses,
  periodicidad_capital: c.periodicidadCapital,
  meses_gracia: c.mesesGracia,
  tipo_amortizacion: c.tipoAmortizacion,
  estado: c.estado,
  observaciones: c.observaciones,
})

const filaATasaIBR = (r) => ({
  id: r.id,
  fecha: r.fecha,
  valorEA: Number(r.valor_ea),
  fuente: r.fuente,
})

const tasaIBRAFila = (t) => ({
  id: t.id,
  fecha: t.fecha,
  valor_ea: t.valorEA,
  fuente: t.fuente,
})

/* -------- CRUD: creditos -------- */

export async function fetchCreditos() {
  const { data, error } = await supabase
    .from('creditos')
    .select('*')
    .order('creado_en')
  if (error) throw error
  return (data || []).map(filaACredito)
}

export async function upsertCredito(credito) {
  const fila = creditoAFila(credito)
  const { error } = await supabase
    .from('creditos')
    .upsert(fila, { onConflict: 'id' })
  if (error) throw error
}

export async function deleteCredito(id) {
  const { error } = await supabase
    .from('creditos')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/* -------- CRUD: historico IBR -------- */

export async function fetchHistoricoIBR() {
  const { data, error } = await supabase
    .from('historico_ibr')
    .select('*')
    .order('fecha')
  if (error) throw error
  return (data || []).map(filaATasaIBR)
}

export async function upsertTasaIBR(tasa) {
  const fila = tasaIBRAFila(tasa)
  const { error } = await supabase
    .from('historico_ibr')
    .upsert(fila, { onConflict: 'id' })
  if (error) throw error
}

export async function deleteTasaIBR(id) {
  const { error } = await supabase
    .from('historico_ibr')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/* -------- CRUD: configuracion -------- */

export async function fetchConfiguracion() {
  const { data, error } = await supabase
    .from('configuracion')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    bancos: data.bancos || [],
    decimales: data.decimales ?? 0,
  }
}

export async function upsertConfiguracion({ bancos, decimales }) {
  const { error } = await supabase
    .from('configuracion')
    .upsert({ id: 1, bancos, decimales }, { onConflict: 'id' })
  if (error) throw error
}

/* -------- CRUD: auditoria -------- */

export async function insertAuditoria(entry) {
  const { error } = await supabase
    .from('auditoria')
    .insert({
      fecha_hora: entry.fechaHora || new Date().toISOString(),
      accion: entry.accion,
      usuario: entry.usuario || 'sistema',
      descripcion: entry.descripcion,
    })
  if (error) throw error
}

export async function fetchAuditoria() {
  const { data, error } = await supabase
    .from('auditoria')
    .select('*')
    .order('fecha_hora', { ascending: false })
    .limit(500)
  if (error) throw error
  return (data || []).map((r) => ({
    id: r.id,
    fechaHora: r.fecha_hora,
    accion: r.accion,
    usuario: r.usuario,
    descripcion: r.descripcion,
  }))
}
