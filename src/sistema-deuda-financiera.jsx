import React, { useState, useMemo, useEffect, useRef, createContext, useContext, useReducer } from "react";
import {
  LayoutDashboard, Landmark, TrendingUp, CalendarClock, Calculator,
  Wallet, Settings, Search, Plus, Pencil, Trash2, X, ChevronRight, ChevronLeft, ChevronDown,
  AlertCircle, AlertTriangle, Upload, Download, Home, CircleDot, Info, Check,
  Columns3, ArrowUp, ArrowDown, Clock
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as GraficoTooltip, Legend, ResponsiveContainer,
} from "recharts";
import * as XLSX from "xlsx";

import {
  fetchCreditos, upsertCredito, deleteCredito,
  fetchHistoricoIBR, upsertTasaIBR, deleteTasaIBR,
  fetchConfiguracion, upsertConfiguracion,
  insertAuditoria, fetchAuditoria,
} from "./supabase";

/* ============================================================================
   SISTEMA DE ADMINISTRACIÓN DE DEUDA FINANCIERA
   ----------------------------------------------------------------------------
   ARQUITECTURA (todo en un solo archivo por restricción de la plataforma de
   artifacts, pero separado por capas mediante secciones claramente marcadas):

   1. DESIGN TOKENS         -> variables de estilo (colores, tipografía)
   2. MODELOS               -> forma de los datos (Credito, TasaIBR)
   3. MOTOR FINANCIERO       -> capa de cálculo, aislada de la UI (ESQUELETO)
   4. SERVICIOS / ESTADO     -> "base de datos" en memoria + acciones (CRUD)
   5. COMPONENTES DE UI      -> Sidebar, TopBar, Módulos, Formularios, Tablas
   6. APP                    -> ensamblado y enrutamiento por módulo

   Ningún componente de UI calcula cifras financieras directamente: todo pasa
   por la capa "MOTOR FINANCIERO" (sección 3), aunque hoy esa capa solo tenga
   la forma de las funciones (esqueleto) y no la lógica todavía.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   1. DESIGN TOKENS
   -------------------------------------------------------------------------- */
const TOKENS = `
  :root{
    --navy-950:#0E1A2B;
    --navy-900:#122237;
    --navy-800:#1B2F49;
    --navy-700:#27405F;
    --paper:#F4F6F8;
    --surface:#FFFFFF;
    --ink:#16212E;
    --ink-soft:#5B6675;
    --ink-faint:#8A93A0;
    --line:#DFE3E8;
    --line-soft:#EBEEF1;
    --teal:#0C7C6B;
    --teal-soft:#E4F2EF;
    --teal-strong:#095F52;
    --amber:#B8763A;
    --amber-soft:#FBEEE1;
    --rose:#B23A34;
    --rose-soft:#FBEAEA;
    --font-display:'Sora',ui-sans-serif,system-ui,sans-serif;
    --font-body:'Inter',ui-sans-serif,system-ui,sans-serif;
    --font-mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  *{box-sizing:border-box;}
  .sdf-root{
    font-family:var(--font-body);
    color:var(--ink);
    background:var(--paper);
    min-height:100vh;
    -webkit-font-smoothing:antialiased;
  }
  .sdf-num{font-family:var(--font-mono); font-variant-numeric:tabular-nums; letter-spacing:-0.01em;}
  .sdf-scrollbar::-webkit-scrollbar{width:8px;height:8px;}
  .sdf-scrollbar::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px;}
  .sdf-focus:focus-visible{outline:2px solid var(--teal);outline-offset:2px;}
  @media (prefers-reduced-motion: reduce){ .sdf-root *{ animation:none !important; transition:none !important; } }
`;

/* ----------------------------------------------------------------------------
   2. MODELOS
   -------------------------------------------------------------------------- */
// Credito: {
//   id, banco, numeroObligacion, descripcion,
//   valorDesembolsado, fechaDesembolso, fechaVencimiento, plazoMeses,
//   spread, periodicidadIntereses, periodicidadCapital, mesesGracia,
//   tipoAmortizacion, estado, observaciones
// }
// TasaIBR: { id, fecha, valorEA, fuente }

const BANCOS_SUGERIDOS = ["Bancolombia", "Davivienda", "BBVA", "Banco de Bogotá", "Finagro", "Banco Agrario", "Otro"];
const ESTADOS_CREDITO = ["Activo", "En gracia", "Mora", "Cancelado"];
const PERIODICIDADES = ["Mensual", "Trimestral", "Semestral", "Anual"];
const TIPOS_AMORTIZACION = [
  { value: "capital_constante", label: "Capital constante" },
  { value: "capital_constante_gracia", label: "Capital constante con período de gracia" },
];

function nuevoId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ----------------------------------------------------------------------------
   3. MOTOR FINANCIERO
   ----------------------------------------------------------------------------
   Única fuente de verdad para todo cálculo. Cronograma, Causación y Flujo de
   Caja consumen exclusivamente estas funciones — ningún componente de UI
   recalcula nada por su cuenta. El Dashboard Ejecutivo queda para una etapa
   posterior (calcularIndicadoresDashboard sigue como TODO, sin tocar).

   Arquitectura interna modular (cada pieza es independiente y reutilizable):
     3.1  Utilidades de fecha y convención 30/360
     3.2  Validación
     3.3  GeneradorEventos            -> fechas relevantes del crédito
     3.4  CalculadorIntereses         -> interés = saldo × tasa × (días/360)
     3.5  GeneradorPeriodos           -> períodos financieros independientes
     3.6  GeneradorCronograma         -> cronograma (vista de caja)
     3.7  GeneradorDistribucionContable -> causación mensual (vista contable,
          independiente del cronograma, ambos derivan de Períodos + Eventos)
     3.8  GeneradorFlujoCaja          -> consolidado multi-crédito
     3.9  Ensamblado (procesarCredito) + caché para rendimiento

   Reglas de negocio implementadas:
     - Base financiera 30/360 (meses de 30 días, año de 360 días). El total de
       días de cada período y su distribución mensual contable provienen de la
       MISMA función (distribuirDiasPorMes), por lo que la causación siempre
       suma exactamente el interés del período — no pueden desalinearse.
     - Tasa = IBR vigente al INICIO del período de intereses que contiene la
       fecha + Spread fijo. Una IBR cargada después del inicio de un período
       nunca lo recalcula.
     - Capital y Cuota de intereses tienen periodicidades independientes. Los
       "períodos financieros" se construyen sobre la UNIÓN de todas las fechas
       de pago (capital + intereses), así que el saldo usado para calcular
       interés siempre refleja las amortizaciones de capital ya ocurridas,
       aunque hayan sido en una fecha que no era de pago de intereses.
     - El interés se ACUMULA en cada período financiero, pero solo se "paga"
       (columna Interés / Interés pagado) en fechas de pago de intereses,
       pago conjunto o vencimiento. Esta distinción ya existía en el diseño
       de la tabla de Causación (Interés causado vs. Interés pagado).
     - Período de gracia: no amortiza capital (solo paga intereses); al
       terminar, inicia automáticamente la amortización de capital constante.
     - La última cuota de capital siempre absorbe el saldo restante exacto
       (en vez del monto constante redondeado), garantizando saldo final = 0
       y que la suma de amortizaciones sea exactamente el valor desembolsado.
       Cualquier ajuste se registra en `ajustesRedondeo` para auditoría.
     - Todos los cálculos internos usan precisión completa (sin redondear);
       el redondeo solo debe aplicarse al presentar en pantalla.
   -------------------------------------------------------------------------- */

/* 3.1 — Utilidades de fecha (ISO 'YYYY-MM-DD', comparables como texto) */
function parseISO(fechaISO) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  return { y, m, d };
}
function pad2(n) { return String(n).padStart(2, "0"); }
function toISO({ y, m, d }) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function esBisiesto(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function diasEnMesCalendario(y, m) {
  return [31, esBisiesto(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
function sumarMeses(fechaISO, n) {
  const { y, m, d } = parseISO(fechaISO);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, diasEnMesCalendario(ny, nm));
  return toISO({ y: ny, m: nm, d: nd });
}

/**
 * Distribuye los días financieros 30/360 entre fechaInicio (exclusiva) y
 * fechaFin (inclusiva) por mes calendario. Es la ÚNICA función que decide
 * "cuántos días financieros tiene cada mes" — la usan tanto el cálculo de
 * interés del período (sumando el total) como la Distribución Contable
 * (usando el detalle por mes), así que ambos SIEMPRE cuadran exactamente.
 * Ejemplo (el del enunciado): 15/01 -> 15/04 = [15, 30, 30, 15] = 90 días.
 */
function distribuirDiasPorMes(fechaInicioISO, fechaFinISO) {
  const a = parseISO(fechaInicioISO);
  const b = parseISO(fechaFinISO);
  const ad = Math.min(a.d, 30);
  const bd = b.d === 31 ? 30 : b.d;
  const buckets = [];
  let cy = a.y, cm = a.m, cd = ad;
  while (cy < b.y || (cy === b.y && cm < b.m)) {
    const dias = 30 - cd;
    if (dias > 0) buckets.push({ anio: cy, mes: cm, dias });
    cm += 1;
    if (cm > 12) { cm = 1; cy += 1; }
    cd = 0;
  }
  const diasFinal = bd - cd;
  if (diasFinal > 0) buckets.push({ anio: cy, mes: cm, dias: diasFinal });
  return buckets;
}
function diasFinancieros360(fechaInicioISO, fechaFinISO) {
  return distribuirDiasPorMes(fechaInicioISO, fechaFinISO).reduce((s, b) => s + b.dias, 0);
}

const MESES_POR_PERIODICIDAD = { Mensual: 1, Trimestral: 3, Semestral: 6, Anual: 12 };
function mesesPorPeriodicidad(periodicidad) {
  const meses = MESES_POR_PERIODICIDAD[periodicidad];
  if (!meses) throw new ErrorMotorFinanciero([`Periodicidad no soportada: "${periodicidad}"`]);
  return meses;
}

function redondear(valor, decimales = 2) {
  const f = Math.pow(10, decimales);
  return Math.round((valor + Number.EPSILON) * f) / f;
}

class ErrorMotorFinanciero extends Error {
  constructor(errores) {
    super(errores.join(" | "));
    this.name = "ErrorMotorFinanciero";
    this.errores = errores;
  }
}

/* 3.2 — Validación: nunca calcular sobre datos incompletos o inconsistentes */
function validarCredito(credito, historicoIBR) {
  const errores = [];
  if (!credito) { errores.push("El crédito no existe."); return { valido: false, errores }; }
  if (!credito.fechaDesembolso) errores.push("Falta la fecha de desembolso.");
  if (!credito.fechaVencimiento) errores.push("Falta la fecha de vencimiento.");
  if (credito.fechaDesembolso && credito.fechaVencimiento && credito.fechaVencimiento <= credito.fechaDesembolso) {
    errores.push("La fecha de vencimiento debe ser posterior a la fecha de desembolso.");
  }
  if (credito.spread === undefined || credito.spread === null || Number(credito.spread) < 0 || Number.isNaN(Number(credito.spread))) {
    errores.push("El spread debe ser un número mayor o igual a 0.");
  }
  if (!credito.valorDesembolsado || Number(credito.valorDesembolsado) <= 0) {
    errores.push("El valor desembolsado debe ser mayor que 0.");
  }
  if (!credito.plazoMeses || Number(credito.plazoMeses) <= 0) {
    errores.push("El plazo en meses debe ser mayor que 0.");
  }
  if (!MESES_POR_PERIODICIDAD[credito.periodicidadIntereses]) errores.push(`Periodicidad de intereses no soportada: "${credito.periodicidadIntereses}".`);
  if (!MESES_POR_PERIODICIDAD[credito.periodicidadCapital]) errores.push(`Periodicidad de capital no soportada: "${credito.periodicidadCapital}".`);
  if (credito.tipoAmortizacion === "capital_constante_gracia") {
    if (!credito.mesesGracia || Number(credito.mesesGracia) <= 0) errores.push("Debe indicar los meses de gracia.");
    if (credito.plazoMeses && Number(credito.mesesGracia) >= Number(credito.plazoMeses)) {
      errores.push("Los meses de gracia deben ser menores al plazo total.");
    }
  }
  if (!historicoIBR || historicoIBR.length === 0) {
    errores.push("No hay tasas IBR cargadas.");
  } else if (credito.fechaDesembolso && !historicoIBR.some((t) => t.fecha <= credito.fechaDesembolso)) {
    errores.push(`No existe una tasa IBR vigente para la fecha de desembolso (${credito.fechaDesembolso}).`);
  }
  return { valido: errores.length === 0, errores };
}

function tasaIBRVigente(historicoIBR, fechaISO) {
  let vigente = null;
  for (const t of historicoIBR) {
    if (t.fecha <= fechaISO && (!vigente || t.fecha > vigente.fecha)) vigente = t;
  }
  if (!vigente) throw new ErrorMotorFinanciero([`No hay tasa IBR vigente para la fecha ${fechaISO}.`]);
  return vigente.valorEA;
}

/* 3.3 — Generador de Eventos Financieros (uso interno del motor, nunca se
   muestra directamente al usuario) */
function generarFechasPeriodicas(inicioISO, finISO, pasoMeses) {
  const fechas = [];
  let cursor = inicioISO;
  while (true) {
    cursor = sumarMeses(cursor, pasoMeses);
    if (cursor >= finISO) break;
    fechas.push(cursor);
  }
  if (finISO > inicioISO) fechas.push(finISO); // el vencimiento siempre cierra el último período
  return fechas;
}

const GeneradorEventos = {
  generar(credito) {
    const fD = credito.fechaDesembolso;
    const fV = credito.fechaVencimiento;
    const tieneGracia = credito.tipoAmortizacion === "capital_constante_gracia" && Number(credito.mesesGracia) > 0;
    const inicioAmortizacion = tieneGracia ? sumarMeses(fD, Number(credito.mesesGracia)) : fD;

    const fechasIntereses = generarFechasPeriodicas(fD, fV, mesesPorPeriodicidad(credito.periodicidadIntereses));
    const fechasCapital = generarFechasPeriodicas(inicioAmortizacion, fV, mesesPorPeriodicidad(credito.periodicidadCapital));

    const mapa = new Map();
    const addTipo = (fecha, tipo) => {
      if (!mapa.has(fecha)) mapa.set(fecha, new Set());
      mapa.get(fecha).add(tipo);
    };
    addTipo(fD, "DESEMBOLSO");
    if (tieneGracia) {
      addTipo(fD, "INICIO_GRACIA");
      addTipo(inicioAmortizacion, "FIN_GRACIA");
    }
    fechasIntereses.forEach((f) => addTipo(f, "PAGO_INTERES"));
    fechasCapital.forEach((f) => addTipo(f, "PAGO_CAPITAL"));
    addTipo(fV, "VENCIMIENTO");

    const eventos = Array.from(mapa.entries())
      .map(([fecha, tipos]) => {
        const arr = Array.from(tipos);
        if (arr.includes("PAGO_INTERES") && arr.includes("PAGO_CAPITAL")) arr.push("PAGO_CONJUNTO");
        return { fecha, tipos: arr };
      })
      .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));

    return { eventos, fechasIntereses, fechasCapital, inicioAmortizacion };
  },
};

/* 3.4 — Calculador de Intereses (función pura, usada por el Generador de
   Períodos): Interés = Saldo Inicial × Tasa × (Días financieros / 360) */
const CalculadorIntereses = {
  calcular(saldoInicial, tasaTotalPct, diasFinancieros) {
    const interes = saldoInicial * (tasaTotalPct / 100) * (diasFinancieros / 360);
    return interes < 0 ? 0 : interes; // nunca intereses negativos
  },
};

/* 3.5 — Generador de Períodos Financieros: construye períodos independientes
   a partir de la unión de TODAS las fechas de evento (capital + intereses),
   cada uno con su propio saldo, tasa, días e interés. */
const GeneradorPeriodos = {
  generar(credito, eventosInfo, historicoIBR) {
    const { eventos, fechasIntereses, fechasCapital, inicioAmortizacion } = eventosInfo;
    const fD = credito.fechaDesembolso;
    const limitesIntereses = [fD, ...fechasIntereses]; // arranque de cada período de intereses
    const ultimaFechaCapital = fechasCapital[fechasCapital.length - 1];
    const numeroCuotasCapital = fechasCapital.length;
    const montoConstante = numeroCuotasCapital > 0 ? Number(credito.valorDesembolsado) / numeroCuotasCapital : 0;

    // La IBR de un período nunca cambia aunque se carguen tasas nuevas después:
    // siempre se usa la vigente en la fecha de INICIO del período de intereses
    // que contiene a la fecha dada.
    const tasaParaFecha = (fecha) => {
      let limite = limitesIntereses[0];
      for (const l of limitesIntereses) {
        if (l <= fecha) limite = l; else break;
      }
      return { ibr: tasaIBRVigente(historicoIBR, limite), fechaReferenciaIBR: limite };
    };

    const fechas = eventos.map((e) => e.fecha); // ordenado y sin duplicados
    const periodos = [];
    const ajustesRedondeo = [];
    let saldo = Number(credito.valorDesembolsado);

    for (let i = 0; i < fechas.length - 1; i++) {
      const inicio = fechas[i];
      const fin = fechas[i + 1];
      const { ibr, fechaReferenciaIBR } = tasaParaFecha(inicio);
      const spread = Number(credito.spread);
      const tasaTotal = ibr + spread;
      const dias = diasFinancieros360(inicio, fin);
      const interes = CalculadorIntereses.calcular(saldo, tasaTotal, dias);

      const enGracia = fin <= inicioAmortizacion;
      let capitalAmortizado = 0;
      if (!enGracia && fechasCapital.includes(fin)) {
        if (fin === ultimaFechaCapital) {
          // la última cuota absorbe el saldo restante exacto (nunca el monto
          // constante redondeado), garantizando saldo final = 0.
          capitalAmortizado = saldo;
          const diferencia = capitalAmortizado - montoConstante;
          if (Math.abs(diferencia) > 1e-6) {
            ajustesRedondeo.push({ fecha: fin, diferencia, motivo: "Ajuste de última cuota de capital" });
          }
        } else {
          capitalAmortizado = montoConstante;
        }
      }
      capitalAmortizado = Math.min(capitalAmortizado, saldo); // nunca saldo negativo
      const saldoFinal = Math.max(0, saldo - capitalAmortizado);

      periodos.push({
        fechaInicio: inicio,
        fechaFin: fin,
        diasFinancieros: dias,
        saldoInicial: saldo,
        saldoFinal,
        ibrAplicada: ibr,
        fechaReferenciaIBR,
        spread,
        tasaTotal,
        capitalAmortizado,
        interesCalculado: interes,
      });

      saldo = saldoFinal;
    }

    return { periodos, ajustesRedondeo, montoConstanteCapital: montoConstante, numeroCuotasCapital };
  },
};

/* 3.6 — Generador del Cronograma: vista de CAJA. El interés solo se muestra
   como "pagado" en fechas de pago de intereses / pago conjunto / vencimiento;
   en fechas donde solo se paga capital, el interés sigue acumulándose. */
const GeneradorCronograma = {
  generar(credito, eventosInfo, periodosInfo) {
    const { eventos } = eventosInfo;
    const { periodos } = periodosInfo;
    const eventosPorFecha = new Map(eventos.map((e) => [e.fecha, e.tipos]));

    const filas = [{
      fecha: credito.fechaDesembolso,
      tipoEvento: "DESEMBOLSO",
      capitalInicial: 0,
      ibrAplicada: null,
      spread: Number(credito.spread),
      tasaTotal: null,
      interes: 0,
      capitalPagado: 0,
      pagoTotal: 0,
      saldo: Number(credito.valorDesembolsado),
    }];

    let interesAcumuladoNoPagado = 0;
    for (const p of periodos) {
      interesAcumuladoNoPagado += p.interesCalculado;
      const tipos = eventosPorFecha.get(p.fechaFin) || [];
      const esPagoIntereses = tipos.includes("PAGO_INTERES") || tipos.includes("PAGO_CONJUNTO") || tipos.includes("VENCIMIENTO");
      const interesFila = esPagoIntereses ? interesAcumuladoNoPagado : 0;
      if (esPagoIntereses) interesAcumuladoNoPagado = 0;

      filas.push({
        fecha: p.fechaFin,
        tipoEvento: tipos.filter((t) => t !== "FIN_GRACIA" && t !== "INICIO_GRACIA").join("+") || "PERIODO",
        capitalInicial: p.saldoInicial,
        ibrAplicada: p.ibrAplicada,
        spread: p.spread,
        tasaTotal: p.tasaTotal,
        diasFinancieros: p.diasFinancieros,
        interes: interesFila,
        capitalPagado: p.capitalAmortizado,
        pagoTotal: interesFila + p.capitalAmortizado,
        saldo: p.saldoFinal,
      });
    }
    return filas;
  },
};

/* 3.7 — Generador de Distribución Contable (causación mensual). Es
   INDEPENDIENTE del Generador del Cronograma: ambos derivan directamente de
   Períodos + Eventos, no uno del otro, evitando duplicar lógica de cálculo. */
const GeneradorDistribucionContable = {
  generar(eventosInfo, periodosInfo) {
    const { eventos } = eventosInfo;
    const { periodos } = periodosInfo;
    const eventosPorFecha = new Map(eventos.map((e) => [e.fecha, e.tipos]));
    const mesesMap = new Map();
    const obtenerFila = (anio, mes) => {
      const key = `${anio}-${pad2(mes)}`;
      if (!mesesMap.has(key)) mesesMap.set(key, { anio, mes, diasFinancieros: 0, interesCausado: 0, interesPagado: 0 });
      return mesesMap.get(key);
    };

    let interesAcumuladoNoPagado = 0;
    for (const p of periodos) {
      const buckets = distribuirDiasPorMes(p.fechaInicio, p.fechaFin);
      let asignado = 0;
      buckets.forEach((b, idx) => {
        // el último mes del período absorbe el residuo para que la suma de
        // la distribución cuadre EXACTAMENTE con el interés del período.
        const monto = idx === buckets.length - 1
          ? p.interesCalculado - asignado
          : p.interesCalculado * (b.dias / p.diasFinancieros);
        if (idx !== buckets.length - 1) asignado += monto;
        const fila = obtenerFila(b.anio, b.mes);
        fila.diasFinancieros += b.dias;
        fila.interesCausado += monto;
      });

      interesAcumuladoNoPagado += p.interesCalculado;
      const tipos = eventosPorFecha.get(p.fechaFin) || [];
      const esPago = tipos.includes("PAGO_INTERES") || tipos.includes("PAGO_CONJUNTO") || tipos.includes("VENCIMIENTO");
      if (esPago) {
        const [ay, am] = p.fechaFin.split("-").map(Number);
        obtenerFila(ay, am).interesPagado += interesAcumuladoNoPagado;
        interesAcumuladoNoPagado = 0;
      }
    }

    const meses = Array.from(mesesMap.keys()).sort().map((k) => mesesMap.get(k));
    let acumulado = 0;
    let pagadoAcumulado = 0;
    return meses.map((m) => {
      acumulado += m.interesCausado;
      pagadoAcumulado += m.interesPagado;
      return {
        mesContable: `${m.anio}-${pad2(m.mes)}`,
        diasFinancieros: m.diasFinancieros,
        interesCausado: m.interesCausado,
        interesAcumulado: acumulado,
        interesPagado: m.interesPagado,
        saldoPendienteCausar: acumulado - pagadoAcumulado,
      };
    });
  },
};

/* 3.8 — Generador de Flujo de Caja: consolida los pagos futuros de varios
   créditos (cada uno ya procesado por el motor) en una sola línea de tiempo. */
const GeneradorFlujoCaja = {
  generar(creditosConCronograma) {
    const filas = [];
    for (const { credito, cronograma } of creditosConCronograma) {
      cronograma
        .filter((f) => f.tipoEvento !== "DESEMBOLSO" && (f.capitalPagado > 0 || f.interes > 0))
        .forEach((f) => {
          filas.push({
            fecha: f.fecha,
            banco: credito.banco,
            numeroObligacion: credito.numeroObligacion,
            pagoCapital: f.capitalPagado,
            pagoIntereses: f.interes,
            pagoTotal: f.pagoTotal,
          });
        });
    }
    filas.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
    return filas;
  },
};

/* 3.9 — Ensamblado por crédito + caché (rendimiento: evita recalcular si el
   crédito y el histórico IBR relevantes no cambiaron). */
const _cacheMotor = new Map();
function _claveCache(credito, historicoIBR) {
  return JSON.stringify(credito) + "|" + JSON.stringify(historicoIBR);
}
function procesarCredito(credito, historicoIBR) {
  const { valido, errores } = validarCredito(credito, historicoIBR);
  if (!valido) throw new ErrorMotorFinanciero(errores);

  const clave = _claveCache(credito, historicoIBR);
  if (_cacheMotor.has(clave)) return _cacheMotor.get(clave);

  const eventosInfo = GeneradorEventos.generar(credito);
  const periodosInfo = GeneradorPeriodos.generar(credito, eventosInfo, historicoIBR);
  const cronograma = GeneradorCronograma.generar(credito, eventosInfo, periodosInfo);
  const causacion = GeneradorDistribucionContable.generar(eventosInfo, periodosInfo);

  const resultado = { eventosInfo, periodosInfo, cronograma, causacion };
  if (_cacheMotor.size > 200) _cacheMotor.clear(); // evita crecimiento indefinido
  _cacheMotor.set(clave, resultado);
  return resultado;
}

const MotorFinanciero = {
  validarCredito,
  procesarCredito,

  /**
   * Consulta de solo lectura: IBR vigente para una fecha dada, según el
   * histórico. No es un cálculo nuevo — expone la misma función interna que
   * ya usa el motor para tarificar los períodos. Devuelve null si no hay
   * tasa disponible para esa fecha (en vez de lanzar excepción), para que la
   * interfaz pueda mostrar "—" sin necesidad de try/catch.
   * @param {Array} historicoIBR
   * @param {string} fechaISO
   * @returns {number|null}
   */
  obtenerIBRVigente(historicoIBR, fechaISO) {
    try {
      return tasaIBRVigente(historicoIBR, fechaISO);
    } catch {
      return null;
    }
  },

  /**
   * Genera el cronograma financiero completo de un crédito (vista de caja).
   * @param {Object} credito
   * @param {Array} historicoIBR - tasas IBR ordenadas por fecha
   * @returns {{filas: Array, errores: Array<string>}} filas: { fecha,
   *   tipoEvento, capitalInicial, ibrAplicada, spread, tasaTotal, interes,
   *   capitalPagado, pagoTotal, saldo }. Si el crédito no es válido, `filas`
   *   viene vacío y `errores` trae los mensajes para mostrar al usuario.
   */
  calcularCronograma(credito, historicoIBR) {
    try {
      return { filas: procesarCredito(credito, historicoIBR).cronograma, errores: [] };
    } catch (e) {
      return { filas: [], errores: e.errores || [e.message] };
    }
  },

  /**
   * Genera la tabla de causación mensual (distribución contable) de un
   * crédito. Independiente del cronograma; ambos parten de Períodos+Eventos.
   * @param {Object} credito
   * @param {Array} historicoIBR
   * @returns {{filas: Array, errores: Array<string>}} filas: { mesContable,
   *   diasFinancieros, interesCausado, interesAcumulado, interesPagado,
   *   saldoPendienteCausar }
   */
  calcularCausacion(credito, historicoIBR) {
    try {
      return { filas: procesarCredito(credito, historicoIBR).causacion, errores: [] };
    } catch (e) {
      return { filas: [], errores: e.errores || [e.message] };
    }
  },

  /**
   * 3.8 — Generador de Flujo de Caja: consolida los pagos futuros de varios
   * créditos en una sola línea de tiempo.
   * @param {Array} creditos
   * @param {Array} historicoIBR
   * @returns {{filas: Array, errores: Array}} filas: { fecha, banco,
   *   numeroObligacion, pagoCapital, pagoIntereses, pagoTotal }
   */
  calcularFlujoCaja(creditos, historicoIBR) {
    const errores = [];
    const creditosConCronograma = [];
    for (const credito of creditos) {
      try {
        const { cronograma } = procesarCredito(credito, historicoIBR);
        creditosConCronograma.push({ credito, cronograma });
      } catch (e) {
        errores.push({ creditoId: credito.id, errores: e.errores || [e.message] });
      }
    }
    return { filas: GeneradorFlujoCaja.generar(creditosConCronograma), errores };
  },

  /**
   * Calcula los indicadores del dashboard ejecutivo.
   * @param {Array} creditos
   * @param {Array} historicoIBR
   * @returns {Object} indicadores agregados
   */
  calcularIndicadoresDashboard(creditos, historicoIBR) {
    // TODO: se implementa en la etapa del Dashboard Ejecutivo (sin tocar aún).
    return null;
  },
};

/* ----------------------------------------------------------------------------
   4. SERVICIOS / ESTADO
   ----------------------------------------------------------------------------
   4.1 Formato de presentación (esto NO es cálculo financiero, solo texto)
   4.2 Helpers de presentación que CONSUMEN al motor (nunca reimplementan una
       fórmula: solo leen y resumen lo que el motor ya calculó)
   4.3 Contexto de aplicación: datos en memoria + notificaciones + selección
   -------------------------------------------------------------------------- */

/* 4.1 — Formato (Colombia: separador decimal coma, moneda COP) */
const formatCOP = (valor) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: _decimalesMonedaActual, maximumFractionDigits: _decimalesMonedaActual }).format(valor || 0);
const formatNumero = (valor, decimales = 0) =>
  new Intl.NumberFormat("es-CO", { minimumFractionDigits: decimales, maximumFractionDigits: decimales }).format(valor || 0);
const formatFecha = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const formatFechaLarga = (fecha) =>
  new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(fecha);
const formatPct = (valor) => (valor === null || valor === undefined ? "—" : `${formatNumero(valor, 2)}%`);
const hoyISO = () => new Date().toISOString().slice(0, 10);
const mesActualISO = () => hoyISO().slice(0, 7);
const anioDe = (fechaISO) => Number(fechaISO.slice(0, 4));
const mesDe = (fechaISO) => fechaISO.slice(0, 7);
const NOMBRES_MES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const nombreMes = (mesISO) => `${NOMBRES_MES[Number(mesISO.slice(5, 7)) - 1]} ${mesISO.slice(0, 4)}`;

/* 4.2 — Helpers de presentación (consumen MotorFinanciero, no duplican nada) */

// Resumen para el panel lateral / tarjetas: se apoya únicamente en las filas
// de cronograma y en las fechas de eventos que ya entrega el motor.
function obtenerResumenCredito(credito, historicoIBR) {
  try {
    const { cronograma, eventosInfo } = MotorFinanciero.procesarCredito(credito, historicoIBR);
    const hoy = hoyISO();
    const transcurridas = cronograma.filter((f) => f.fecha <= hoy);
    const saldoActual = transcurridas.length ? transcurridas[transcurridas.length - 1].saldo : Number(credito.valorDesembolsado);
    const proximoPago = cronograma.find((f) => f.fecha > hoy && f.tipoEvento !== "DESEMBOLSO" && (f.capitalPagado > 0 || f.interes > 0)) || null;
    const proximoCambioIBR = eventosInfo.fechasIntereses.find((f) => f > hoy) || null;
    return { saldoActual, proximoPago, proximoCambioIBR, errores: null };
  } catch (e) {
    return { saldoActual: null, proximoPago: null, proximoCambioIBR: null, errores: e.errores || [e.message] };
  }
}

// ¿Esta tasa IBR fue realmente usada por algún crédito? Se apoya en
// periodo.fechaReferenciaIBR, que el motor ya calcula internamente.
function tasaEstaEnUso(tasa, creditos, historicoIBR) {
  for (const credito of creditos) {
    try {
      const { periodosInfo } = MotorFinanciero.procesarCredito(credito, historicoIBR);
      if (periodosInfo.periodos.some((p) => p.fechaReferenciaIBR === tasa.fecha)) {
        return { enUso: true, credito };
      }
    } catch {
      // crédito inválido: no puede haber usado esta tasa todavía
    }
  }
  return { enUso: false, credito: null };
}

/* 4.3 — Contexto de aplicación */
const AppContext = createContext(null);
const useApp = () => useContext(AppContext);

const CREDITOS_EJEMPLO = [];
const IBR_EJEMPLO = [];

let _idToast = 0;

/* ----------------------------------------------------------------------------
   4.4 — Persistencia vía Supabase, configuración inicial y manejo de errores
   ----------------------------------------------------------------------------
   La persistencia se realiza mediante llamadas a Supabase en cada operación
   CRUD. El Motor Financiero nunca toca la persistencia directamente.
   -------------------------------------------------------------------------- */
const CONFIGURACION_INICIAL = {
  bancos: BANCOS_SUGERIDOS.map((nombre) => ({ id: nuevoId(), nombre, activo: true })),
  decimales: 0,
  formatoFecha: "DD/MM/AAAA",
};

// Manejo centralizado de errores: nunca se muestran trazas técnicas al
// usuario (eso queda en consola y en este registro interno); el usuario
// siempre recibe un mensaje claro vía notificar(). Se persiste una copia
// acotada (últimos 50) para poder diagnosticar problemas después.
let _erroresSistema = [];
function registrarErrorSistema(error, contexto) {
  const entrada = { fechaHora: new Date().toISOString(), contexto, mensaje: String((error && error.message) || error) };
  _erroresSistema = [entrada, ..._erroresSistema].slice(0, 50);
  console.error(`[SADF] Error en "${contexto}":`, error);
  if (typeof window !== "undefined" && window.storage) {
    window.storage.set("sadf:erroresSistema", JSON.stringify(_erroresSistema), false).catch(() => {});
  }
}
function obtenerErroresSistema() { return _erroresSistema; }

let _decimalesMonedaActual = 0;
function establecerDecimalesMoneda(n) { _decimalesMonedaActual = Number.isFinite(n) ? n : 0; }

// Boundary de errores de React: si algo en la interfaz falla de forma
// inesperada, esto evita una pantalla en blanco o una traza técnica y
// muestra un mensaje tranquilizador — los datos siguen a salvo porque se
// guardan automáticamente en cada cambio, no solo al cerrar la aplicación.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { conError: false }; }
  static getDerivedStateFromError() { return { conError: true }; }
  componentDidCatch(error, info) {
    registrarErrorSistema(error, `Interfaz — ${(info && info.componentStack || "").trim().split("\n")[0]}`);
  }
  render() {
    if (this.state.conError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F4F6F8", fontFamily: "system-ui, sans-serif", padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: "center", background: "#fff", border: "1px solid #DFE3E8", borderRadius: 12, padding: 32 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: "#16212E" }}>Ocurrió un problema inesperado</div>
            <p style={{ fontSize: 13, color: "#5B6675", lineHeight: 1.6, marginBottom: 18 }}>
              La información de sus créditos y tasas IBR está a salvo — se guarda automáticamente con cada cambio. Intente recargar la aplicación.
            </p>
            <button onClick={() => window.location.reload()} style={{ background: "#0C7C6B", color: "#fff", border: "none", borderRadius: 7, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Recargar aplicación</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppProvider({ children, user }) {
  const [creditos, setCreditos] = useState([]);
  const [historicoIBR, setHistoricoIBR] = useState([]);
  const [configuracion, setConfiguracion] = useState(CONFIGURACION_INICIAL);
  const [auditoria, setAuditoria] = useState([]);
  const [modulo, setModuloInterno] = useState("inicio");
  const [busquedaGlobalPendiente, setBusquedaGlobalPendiente] = useState(null);
  const [creditoAAbrirPendiente, setCreditoAAbrirPendiente] = useState(null);
  const [flujoMesPendiente, setFlujoMesPendiente] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [cargandoInicial, setCargandoInicial] = useState(true);

  const notificar = (mensaje, tipo = "exito") => {
    const id = ++_idToast;
    setToasts((prev) => [...prev, { id, mensaje, tipo }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };
  const cerrarToast = (id) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const usuarioEmail = user?.email || "sistema";

  // ---- Carga inicial desde Supabase ----------------------
  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const [c, i, cfg, aud] = await Promise.all([
          fetchCreditos().catch(() => []),
          fetchHistoricoIBR().catch(() => []),
          fetchConfiguracion().catch(() => null),
          fetchAuditoria().catch(() => []),
        ]);
        if (!vigente) return;
        if (c.length) setCreditos(c);
        if (i.length) setHistoricoIBR(i);
        const cfgFinal = cfg || CONFIGURACION_INICIAL;
        setConfiguracion(cfgFinal);
        establecerDecimalesMoneda(cfgFinal.decimales || 0);
        if (aud.length) setAuditoria(aud);
      } catch (e) {
        registrarErrorSistema(e, "Carga inicial desde Supabase");
      } finally {
        if (vigente) setCargandoInicial(false);
      }
    })();
    return () => { vigente = false; };
  }, []);

  useEffect(() => { establecerDecimalesMoneda(configuracion.decimales || 0); }, [configuracion.decimales]);

  const registrarAuditoria = (accion, descripcion) => {
    const entry = { id: nuevoId(), fechaHora: new Date().toISOString(), accion, usuario: usuarioEmail, descripcion };
    setAuditoria((prev) => [entry, ...prev].slice(0, 500));
    insertAuditoria(entry).catch((e) => registrarErrorSistema(e, "Auditoría"));
  };

  const asyncGuardar = async (fn, msg) => {
    try { await fn(); } catch (e) { registrarErrorSistema(e, msg); }
  };

  const setModulo = (m) => setModuloInterno(m);
  const buscarGlobal = (texto) => {
    setBusquedaGlobalPendiente(texto);
    setModuloInterno("creditos");
  };
  const irACreditoDetalle = (creditoId) => {
    setCreditoAAbrirPendiente(creditoId);
    setModuloInterno("creditos");
  };
  const irAFlujoMes = (mesISO) => {
    setFlujoMesPendiente(mesISO);
    setModuloInterno("flujo");
  };

  const api = {
    creditos, historicoIBR, configuracion, auditoria,
    cargandoInicial, modulo, setModulo,
    busquedaGlobalPendiente,
    consumirBusquedaGlobal: () => setBusquedaGlobalPendiente(null),
    buscarGlobal,
    creditoAAbrirPendiente,
    consumirCreditoAAbrir: () => setCreditoAAbrirPendiente(null),
    irACreditoDetalle,
    flujoMesPendiente,
    consumirFlujoMesPendiente: () => setFlujoMesPendiente(null),
    irAFlujoMes,
    toasts, notificar, cerrarToast,

    crearCredito(data) {
      if (creditos.some((c) => c.numeroObligacion === data.numeroObligacion)) {
        notificar(`Ya existe un crédito con el número de obligación "${data.numeroObligacion}".`, "error");
        return { valido: false, errores: ["Número de obligación duplicado."] };
      }
      const validacion = MotorFinanciero.validarCredito(data, historicoIBR);
      const nuevo = { ...data, id: nuevoId() };
      setCreditos((prev) => [...prev, nuevo]);
      asyncGuardar(() => upsertCredito(nuevo), "Guardar crédito");
      registrarAuditoria("Creación de crédito", `Se creó el crédito ${data.numeroObligacion} (${data.banco}).`);
      notificar("Crédito creado correctamente.", "exito");
      if (!validacion.valido) notificar("El crédito se guardó, pero el motor financiero no podrá calcularlo hasta corregir: " + validacion.errores[0], "advertencia");
      return validacion;
    },
    actualizarCredito(id, data) {
      if (creditos.some((c) => c.id !== id && c.numeroObligacion === data.numeroObligacion)) {
        notificar(`Ya existe otro crédito con el número de obligación "${data.numeroObligacion}".`, "error");
        return { valido: false, errores: ["Número de obligación duplicado."] };
      }
      const validacion = MotorFinanciero.validarCredito(data, historicoIBR);
      const editado = { ...data, id };
      setCreditos((prev) => prev.map((c) => (c.id === id ? editado : c)));
      asyncGuardar(() => upsertCredito(editado), "Actualizar crédito");
      registrarAuditoria("Modificación de crédito", `Se editó el crédito ${data.numeroObligacion} (${data.banco}).`);
      notificar("Crédito actualizado.", "exito");
      if (!validacion.valido) notificar("El crédito se guardó, pero el motor financiero no podrá calcularlo hasta corregir: " + validacion.errores[0], "advertencia");
      return validacion;
    },
    eliminarCredito(id) {
      const credito = creditos.find((c) => c.id === id);
      setCreditos((prev) => prev.filter((c) => c.id !== id));
      asyncGuardar(() => deleteCredito(id), "Eliminar crédito");
      if (credito) registrarAuditoria("Eliminación de crédito", `Se eliminó el crédito ${credito.numeroObligacion} (${credito.banco}).`);
      notificar("Crédito eliminado.", "exito");
    },
    async limpiarEjemplo() {
      const idsC = creditos.map((c) => c.id);
      const idsI = historicoIBR.map((t) => t.id);
      setCreditos([]);
      setHistoricoIBR([]);
      idsC.forEach((id) => asyncGuardar(() => deleteCredito(id), "Limpiar crédito"));
      idsI.forEach((id) => asyncGuardar(() => deleteTasaIBR(id), "Limpiar IBR"));
      registrarAuditoria("Eliminación masiva", "Se borraron todos los créditos y tasas IBR desde Configuración.");
      notificar("Se borraron todos los datos.", "exito");
    },
    agregarTasaIBR(data) {
      const nuevo = { ...data, id: nuevoId() };
      setHistoricoIBR((prev) => [...prev, nuevo].sort((a, b) => a.fecha.localeCompare(b.fecha)));
      asyncGuardar(() => upsertTasaIBR(nuevo), "Guardar tasa IBR");
      registrarAuditoria("Registro de IBR", `Se registró la tasa IBR del ${data.fecha} (${data.valorEA}%).`);
      notificar("Tasa IBR registrada.", "exito");
    },
    eliminarTasaIBR(id) {
      const tasa = historicoIBR.find((t) => t.id === id);
      setHistoricoIBR((prev) => prev.filter((t) => t.id !== id));
      asyncGuardar(() => deleteTasaIBR(id), "Eliminar tasa IBR");
      if (tasa) registrarAuditoria("Eliminación de IBR", `Se eliminó la tasa IBR del ${tasa.fecha} (${tasa.valorEA}%).`);
      notificar("Tasa IBR eliminada.", "exito");
    },
    importarCreditosLote(datos) {
      const nuevos = datos.map((d) => ({ ...d, id: nuevoId() }));
      setCreditos((prev) => [...prev, ...nuevos]);
      nuevos.forEach((n) => asyncGuardar(() => upsertCredito(n), "Importar crédito"));
      registrarAuditoria("Importación desde Excel", `Se importaron ${datos.length} crédito(s) desde Excel.`);
      notificar(`${datos.length} crédito(s) importado(s) correctamente.`, "exito");
    },
    importarTasasIBRLote(datos) {
      const nuevos = datos.map((d) => ({ ...d, id: nuevoId() }));
      setHistoricoIBR((prev) => {
        const mapa = new Map(prev.map((t) => [t.fecha, t]));
        nuevos.forEach((d) => {
          if (mapa.has(d.fecha)) mapa.set(d.fecha, { ...mapa.get(d.fecha), valorEA: d.valorEA, fuente: d.fuente });
          else mapa.set(d.fecha, d);
        });
        return Array.from(mapa.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
      });
      nuevos.forEach((n) => asyncGuardar(() => upsertTasaIBR(n), "Importar tasa IBR"));
      registrarAuditoria("Importación desde Excel", `Se importaron/actualizaron ${datos.length} tasa(s) IBR desde Excel.`);
      notificar(`${datos.length} tasa(s) IBR importada(s) correctamente.`, "exito");
    },

    // ---- Catálogo de bancos (Configuración) ----
    crearBanco(nombre) {
      const limpio = nombre.trim();
      if (!limpio) return;
      if (configuracion.bancos.some((b) => b.nombre.toLowerCase() === limpio.toLowerCase())) {
        notificar("Ese banco ya existe en el catálogo.", "error");
        return;
      }
      const nuevaCfg = { ...configuracion, bancos: [...configuracion.bancos, { id: nuevoId(), nombre: limpio, activo: true }] };
      setConfiguracion(nuevaCfg);
      asyncGuardar(() => upsertConfiguracion(nuevaCfg), "Guardar configuración");
      registrarAuditoria("Catálogo de bancos", `Se agregó el banco "${limpio}".`);
      notificar("Banco agregado.", "exito");
    },
    editarBanco(id, nombre) {
      const limpio = nombre.trim();
      if (!limpio) return;
      const nuevaCfg = { ...configuracion, bancos: configuracion.bancos.map((b) => (b.id === id ? { ...b, nombre: limpio } : b)) };
      setConfiguracion(nuevaCfg);
      asyncGuardar(() => upsertConfiguracion(nuevaCfg), "Guardar configuración");
      registrarAuditoria("Catálogo de bancos", `Se renombró un banco a "${limpio}".`);
      notificar("Banco actualizado.", "exito");
    },
    alternarActivoBanco(id) {
      const nuevaCfg = { ...configuracion, bancos: configuracion.bancos.map((b) => (b.id === id ? { ...b, activo: !b.activo } : b)) };
      setConfiguracion(nuevaCfg);
      asyncGuardar(() => upsertConfiguracion(nuevaCfg), "Guardar configuración");
      notificar("Estado del banco actualizado.", "exito");
    },
    eliminarBanco(id) {
      const banco = configuracion.bancos.find((b) => b.id === id);
      if (!banco) return;
      if (creditos.some((c) => c.banco === banco.nombre)) {
        notificar(`No se puede eliminar "${banco.nombre}": tiene créditos asociados. Puede desactivarlo en su lugar.`, "error");
        return;
      }
      const nuevaCfg = { ...configuracion, bancos: configuracion.bancos.filter((b) => b.id !== id) };
      setConfiguracion(nuevaCfg);
      asyncGuardar(() => upsertConfiguracion(nuevaCfg), "Guardar configuración");
      registrarAuditoria("Catálogo de bancos", `Se eliminó el banco "${banco.nombre}" del catálogo.`);
      notificar("Banco eliminado.", "exito");
    },
    establecerDecimales(n) {
      const nuevaCfg = { ...configuracion, decimales: n };
      setConfiguracion(nuevaCfg);
      asyncGuardar(() => upsertConfiguracion(nuevaCfg), "Guardar configuración");
      notificar("Formato monetario actualizado.", "exito");
    },

    // ---- Respaldo y recuperación ----
    async restaurarDesdeRespaldo(datos) {
      const idsViejosC = creditos.map((c) => c.id);
      const idsViejosI = historicoIBR.map((t) => t.id);
      idsViejosC.forEach((id) => asyncGuardar(() => deleteCredito(id), "Limpiar crédito (respaldo)"));
      idsViejosI.forEach((id) => asyncGuardar(() => deleteTasaIBR(id), "Limpiar IBR (respaldo)"));
      const nuevosC = (datos.creditos || []).map((c) => ({ ...c, id: c.id || nuevoId() }));
      const nuevosI = (datos.historicoIBR || []).map((t) => ({ ...t, id: t.id || nuevoId() }));
      setCreditos(nuevosC);
      setHistoricoIBR(nuevosI);
      setConfiguracion(datos.configuracion || CONFIGURACION_INICIAL);
      nuevosC.forEach((n) => asyncGuardar(() => upsertCredito(n), "Restaurar crédito"));
      nuevosI.forEach((n) => asyncGuardar(() => upsertTasaIBR(n), "Restaurar IBR"));
      if (datos.configuracion) asyncGuardar(() => upsertConfiguracion(datos.configuracion), "Restaurar configuración");
      registrarAuditoria("Restauración de respaldo", `Se restauró el sistema desde un archivo de respaldo (${nuevosC.length} créditos, ${nuevosI.length} tasas IBR).`);
      notificar("Sistema restaurado desde el respaldo.", "exito");
    },
  };

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>;
}

/* ----------------------------------------------------------------------------
   5. COMPONENTES DE UI
   -------------------------------------------------------------------------- */

/* 5.0 — Primitivas reutilizables */
function Card({ children, style, ...rest }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: 18, ...style }} {...rest}>
      {children}
    </div>
  );
}

function Boton({ children, variant = "primary", size = "normal", ...rest }) {
  const styles = {
    primary: { background: "var(--teal)", color: "#fff", border: "1px solid var(--teal)" },
    ghost: { background: "transparent", color: "var(--ink-soft)", border: "1px solid var(--line)" },
    danger: { background: "var(--rose-soft)", color: "var(--rose)", border: "1px solid #F0CFCD" },
    sutil: { background: "var(--paper)", color: "var(--ink-soft)", border: "1px solid var(--line)" },
  };
  const padding = size === "chico" ? "6px 10px" : "8px 14px";
  const fontSize = size === "chico" ? 12 : 13;
  return (
    <button
      className="sdf-focus"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding, borderRadius: 7, fontSize, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-body)", whiteSpace: "nowrap", ...styles[variant] }}
      {...rest}
    >
      {children}
    </button>
  );
}

function Campo({ label, children, hint, tooltip, requerido }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 5, display: "flex", alignItems: "center", gap: 5 }}>
        {label}{requerido && <span style={{ color: "var(--rose)" }}>*</span>}
        {tooltip && <InfoTip texto={tooltip} />}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

function InfoTip({ texto }) {
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={texto}
      title={texto}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 14, height: 14, borderRadius: "50%", background: "var(--line-soft)",
        color: "var(--ink-faint)", fontSize: 9.5, fontWeight: 700, cursor: "help",
      }}
    >?</span>
  );
}

const inputStyle = {
  width: "100%", padding: "9px 11px", borderRadius: 7, border: "1px solid var(--line)",
  fontSize: 13.5, fontFamily: "var(--font-body)", color: "var(--ink)", background: "var(--surface)",
};
const inputSoloLecturaStyle = { ...inputStyle, background: "var(--paper)", color: "var(--ink-soft)" };
const thStyle = { textAlign: "left", padding: "10px 14px", fontSize: 11, color: "var(--ink-soft)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" };
const iconBtnStyle = { background: "none", border: "1px solid var(--line)", borderRadius: 6, padding: 6, marginLeft: 6, cursor: "pointer", color: "var(--ink-soft)", display: "inline-flex" };

function ErrorTexto({ texto }) {
  return <div style={{ fontSize: 11, color: "var(--rose)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}><AlertCircle size={11} /> {texto}</div>;
}

function EstadoBadge({ estado }) {
  const map = {
    "Activo": { bg: "var(--teal-soft)", fg: "var(--teal-strong)" },
    "En gracia": { bg: "var(--amber-soft)", fg: "var(--amber)" },
    "Mora": { bg: "var(--rose-soft)", fg: "var(--rose)" },
    "Cancelado": { bg: "var(--line-soft)", fg: "var(--ink-soft)" },
  };
  const s = map[estado] || map["Activo"];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: s.bg, color: s.fg, fontSize: 11.5, fontWeight: 600, padding: "3px 9px", borderRadius: 20, whiteSpace: "nowrap" }}>
      <CircleDot size={10} /> {estado}
    </span>
  );
}

function Interruptor({ activo, onChange, etiqueta }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={etiqueta}
      onClick={() => onChange(!activo)}
      className="sdf-focus"
      style={{
        display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0,
      }}
    >
      <span style={{
        width: 34, height: 19, borderRadius: 20, background: activo ? "var(--teal)" : "var(--line)",
        position: "relative", transition: "background 150ms ease", flexShrink: 0,
      }}>
        <span style={{
          position: "absolute", top: 2, left: activo ? 17 : 2, width: 15, height: 15, borderRadius: "50%",
          background: "#fff", transition: "left 150ms ease", boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        }} />
      </span>
      <span style={{ fontSize: 13, color: "var(--ink)" }}>{etiqueta}</span>
    </button>
  );
}

function Spinner({ etiqueta = "Calculando…" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 40, justifyContent: "center", color: "var(--ink-faint)", fontSize: 13 }}>
      <span style={{
        width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--line)",
        borderTopColor: "var(--teal)", animation: "sdf-spin 700ms linear infinite",
      }} />
      {etiqueta}
    </div>
  );
}

// Hook: mantiene un pequeño estado de "cargando" mientras se recalcula algo
// pesado (cronograma / causación / flujo con muchos créditos), para dar
// retroalimentación visual sin bloquear la interfaz.
function useCalculoConCarga(calcular, deps) {
  const [estado, setEstado] = useState({ cargando: true, valor: null });
  useEffect(() => {
    setEstado((e) => ({ cargando: true, valor: e.valor }));
    const t = setTimeout(() => {
      setEstado({ cargando: false, valor: calcular() });
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return estado;
}

function usePaginacion(items, tamPagina) {
  const [pagina, setPagina] = useState(1);
  useEffect(() => { setPagina(1); }, [items.length, tamPagina]);
  const totalPaginas = Math.max(1, Math.ceil(items.length / tamPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const inicio = (paginaSegura - 1) * tamPagina;
  const pageItems = items.slice(inicio, inicio + tamPagina);
  return { pageItems, pagina: paginaSegura, totalPaginas, setPagina };
}

function ControlPaginacion({ pagina, totalPaginas, setPagina, total }) {
  if (totalPaginas <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: "1px solid var(--line)" }}>
      <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>{total} registro(s)</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="sdf-focus" disabled={pagina === 1} onClick={() => setPagina(pagina - 1)} style={{ ...iconBtnStyle, margin: 0, opacity: pagina === 1 ? 0.4 : 1 }} aria-label="Página anterior"><ChevronLeft size={14} /></button>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Página {pagina} de {totalPaginas}</span>
        <button className="sdf-focus" disabled={pagina === totalPaginas} onClick={() => setPagina(pagina + 1)} style={{ ...iconBtnStyle, margin: 0, opacity: pagina === totalPaginas ? 0.4 : 1 }} aria-label="Página siguiente"><ChevronRight size={14} /></button>
      </div>
    </div>
  );
}

function ConfirmarEliminacion({ titulo, descripcion, advertencia, onCancelar, onConfirmar, textoConfirmar = "Eliminar" }) {
  return (
    <div role="alertdialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(14,26,43,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <Card style={{ width: 380 }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <AlertCircle size={18} color="var(--rose)" style={{ flexShrink: 0 }} />
          <strong style={{ fontSize: 14 }}>{titulo}</strong>
        </div>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 10px" }}>{descripcion}</p>
        {advertencia && (
          <div style={{ display: "flex", gap: 8, background: "var(--amber-soft)", color: "var(--amber)", padding: "8px 10px", borderRadius: 7, fontSize: 12.5, marginBottom: 14 }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {advertencia}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: advertencia ? 0 : 16 }}>
          <Boton variant="ghost" onClick={onCancelar}>Cancelar</Boton>
          <Boton variant="danger" onClick={onConfirmar}>{textoConfirmar}</Boton>
        </div>
      </Card>
    </div>
  );
}

/* Toasts (mensajes claros, nunca técnicos) */
function ToastCentro() {
  const { toasts, cerrarToast } = useApp();
  const estilos = {
    exito: { bg: "var(--teal-strong)", Icono: Check },
    advertencia: { bg: "var(--amber)", Icono: AlertTriangle },
    error: { bg: "var(--rose)", Icono: AlertCircle },
  };
  return (
    <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 100, display: "flex", flexDirection: "column", gap: 8, maxWidth: 340 }} role="status" aria-live="polite">
      {toasts.map((t) => {
        const s = estilos[t.tipo] || estilos.exito;
        const Icono = s.Icono;
        return (
          <div key={t.id} style={{
            background: s.bg, color: "#fff", padding: "11px 14px", borderRadius: 8, fontSize: 13,
            display: "flex", alignItems: "flex-start", gap: 9, boxShadow: "0 8px 20px rgba(14,26,43,0.22)",
          }}>
            <Icono size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, lineHeight: 1.4 }}>{t.mensaje}</span>
            <button onClick={() => cerrarToast(t.id)} aria-label="Cerrar mensaje" style={{ background: "none", border: "none", color: "rgba(255,255,255,0.8)", cursor: "pointer", padding: 0 }}><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

/* 5.1 — Navegación: header global, sidebar, encabezado por módulo */
const NAV_ITEMS = [
  { key: "inicio", label: "Inicio", icon: Home },
  { key: "creditos", label: "Créditos", icon: Landmark },
  { key: "ibr", label: "IBR", icon: TrendingUp },
  { key: "cronograma", label: "Cronograma", icon: CalendarClock },
  { key: "causacion", label: "Causación", icon: Calculator },
  { key: "flujo", label: "Flujo de Caja", icon: Wallet },
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "configuracion", label: "Configuración", icon: Settings },
];

function Sidebar() {
  const { modulo, setModulo } = useApp();
  return (
    <aside style={{ width: 224, flexShrink: 0, background: "var(--navy-950)", color: "#C9D4E3", display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0 }}>
      <div style={{ padding: "22px 20px 18px" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, color: "#FFFFFF", letterSpacing: "-0.01em" }}>
          Deuda<span style={{ color: "#3ED9B8" }}>Fin</span>
        </div>
        <div style={{ fontSize: 11.5, color: "#7C8CA6", marginTop: 2 }}>Administración de créditos</div>
      </div>
      <nav style={{ flex: 1, padding: "4px 12px", overflowY: "auto" }} aria-label="Navegación principal">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const activo = modulo === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setModulo(item.key)}
              className="sdf-focus"
              aria-current={activo ? "page" : undefined}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", marginBottom: 2, borderRadius: 7,
                background: activo ? "var(--navy-800)" : "transparent", border: "none", cursor: "pointer",
                color: activo ? "#FFFFFF" : "#9FB0C7", fontSize: 13.5, fontFamily: "var(--font-body)",
                fontWeight: activo ? 600 : 500, textAlign: "left",
                borderLeft: activo ? "2px solid #3ED9B8" : "2px solid transparent",
              }}
            >
              <Icon size={16} strokeWidth={2} />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: "14px 20px 18px", borderTop: "1px solid var(--navy-800)" }}>
        <div style={{ fontSize: 11, color: "#5E6E85" }}>Base financiera</div>
        <div className="sdf-num" style={{ fontSize: 12.5, color: "#9FB0C7", marginTop: 2 }}>30/360 · COP</div>
      </div>
    </aside>
  );
}

function HeaderGlobal() {
  const { historicoIBR, buscarGlobal } = useApp();
  const [busqueda, setBusqueda] = useState("");
  const ultima = historicoIBR.length ? historicoIBR[historicoIBR.length - 1] : null;

  const enviarBusqueda = () => {
    if (busqueda.trim()) buscarGlobal(busqueda.trim());
  };

  return (
    <header style={{
      height: 58, flexShrink: 0, display: "flex", alignItems: "center", gap: 18,
      padding: "0 24px", borderBottom: "1px solid var(--line)", background: "var(--surface)",
    }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-soft)", whiteSpace: "nowrap", textTransform: "capitalize" }}>
        {formatFechaLarga(new Date())}
      </div>

      <div style={{ flex: 1, maxWidth: 440, position: "relative" }}>
        <Search size={14} style={{ position: "absolute", left: 11, top: 10, color: "var(--ink-faint)" }} />
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") enviarBusqueda(); }}
          placeholder="Buscar crédito por banco, obligación o descripción…"
          aria-label="Búsqueda global de créditos"
          style={{ ...inputStyle, paddingLeft: 32, background: "var(--paper)" }}
        />
      </div>

      <div style={{ flex: 1 }} />

      <div style={{
        display: "flex", alignItems: "center", gap: 7, background: "var(--teal-soft)",
        color: "var(--teal-strong)", padding: "6px 12px", borderRadius: 20, fontSize: 12.5, fontWeight: 600,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--teal)" }} />
        IBR {ultima ? `${formatPct(ultima.valorEA)} EA` : "sin datos"}
      </div>

      <button
        type="button"
        title="Menú de usuario — disponible en una próxima versión"
        className="sdf-focus"
        style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "1px solid var(--line)", borderRadius: 20, padding: "5px 12px 5px 5px", cursor: "default" }}
      >
        <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--navy-900)", color: "#fff", fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>DF</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Director Financiero</span>
      </button>
    </header>
  );
}

function TopBar({ titulo, subtitulo, acciones }) {
  return (
    <div style={{ padding: "20px 32px 18px", borderBottom: "1px solid var(--line)", background: "var(--surface)", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 21, margin: 0, color: "var(--ink)", fontWeight: 700 }}>{titulo}</h1>
        {subtitulo && <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>{subtitulo}</p>}
      </div>
      {acciones && <div style={{ display: "flex", gap: 8 }}>{acciones}</div>}
    </div>
  );
}

/* ---- 5.2 Módulo: Inicio (resumen ejecutivo) ---------------------------- */
function ModuloInicio() {
  const { creditos, historicoIBR, setModulo } = useApp();
  const hoy = hoyISO();

  const resumenPorCredito = useMemo(
    () => creditos.map((c) => ({ credito: c, resumen: obtenerResumenCredito(c, historicoIBR) })),
    [creditos, historicoIBR]
  );

  const activos = creditos.filter((c) => c.estado === "Activo" || c.estado === "En gracia");
  const saldoTotal = resumenPorCredito.reduce((s, r) => s + (r.resumen.saldoActual || 0), 0);
  const enGracia = creditos.filter((c) => c.estado === "En gracia").length;
  const ultimaIBR = historicoIBR.length ? historicoIBR[historicoIBR.length - 1] : null;

  const { filas: flujoMes } = useMemo(() => MotorFinanciero.calcularFlujoCaja(creditos, historicoIBR), [creditos, historicoIBR]);
  const interesesDelMes = flujoMes.filter((f) => mesDe(f.fecha) === mesActualISO()).reduce((s, f) => s + f.pagoIntereses, 0);
  const proximosPagos = flujoMes.filter((f) => f.fecha >= hoy).slice(0, 6);
  const proximoPago = proximosPagos[0] || null;

  const tarjetas = [
    { label: "Créditos activos", valor: activos.length, icono: Landmark },
    { label: "Saldo total de deuda", valor: formatCOP(saldoTotal), icono: Wallet },
    { label: "Próximo pago", valor: proximoPago ? formatFecha(proximoPago.fecha) : "—", sub: proximoPago ? formatCOP(proximoPago.pagoTotal) : null, icono: CalendarClock },
    { label: "Intereses por pagar este mes", valor: formatCOP(interesesDelMes), icono: TrendingUp },
    { label: "Créditos con período de gracia", valor: enGracia, icono: Clock },
    { label: "IBR — última actualización", valor: ultimaIBR ? `${formatPct(ultimaIBR.valorEA)} EA` : "—", sub: ultimaIBR ? formatFecha(ultimaIBR.fecha) : null, icono: TrendingUp },
  ];

  const errores = resumenPorCredito.filter((r) => r.resumen.errores);

  return (
    <>
      <TopBar titulo="Resumen ejecutivo" subtitulo="Vista general de la deuda financiera de la compañía" />
      <div style={{ padding: 32 }}>
        {errores.length > 0 && (
          <Card style={{ marginBottom: 18, background: "var(--amber-soft)", border: "1px solid #EAD3B0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <AlertTriangle size={16} color="var(--amber)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 13, color: "var(--ink)" }}>
                {errores.length} crédito(s) no se pudieron calcular (datos incompletos o falta IBR para su fecha de desembolso).
                {" "}<button onClick={() => setModulo("creditos")} style={{ color: "var(--teal-strong)", background: "none", border: "none", cursor: "pointer", fontWeight: 600, padding: 0, fontSize: 13, textDecoration: "underline" }}>Revisar en Créditos</button>
              </div>
            </div>
          </Card>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 24 }}>
          {tarjetas.map((t) => {
            const Icono = t.icono;
            return (
              <Card key={t.label}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Icono size={14} color="var(--teal)" />
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{t.label}</div>
                </div>
                <div className="sdf-num" style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{t.valor}</div>
                {t.sub && <div className="sdf-num" style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 2 }}>{t.sub}</div>}
              </Card>
            );
          })}
        </div>

        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 600, fontSize: 14 }}>Próximos vencimientos</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--paper)" }}>
                <th style={thStyle}>Fecha</th><th style={thStyle}>Banco</th><th style={thStyle}>Obligación</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Capital</th><th style={{ ...thStyle, textAlign: "right" }}>Intereses</th><th style={{ ...thStyle, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {proximosPagos.map((f, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                  <td style={{ padding: "10px 14px" }} className="sdf-num">{formatFecha(f.fecha)}</td>
                  <td style={{ padding: "10px 14px" }}>{f.banco}</td>
                  <td style={{ padding: "10px 14px" }} className="sdf-num">{f.numeroObligacion}</td>
                  <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.pagoCapital)}</td>
                  <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.pagoIntereses)}</td>
                  <td style={{ padding: "10px 14px", textAlign: "right", fontWeight: 600 }} className="sdf-num">{formatCOP(f.pagoTotal)}</td>
                </tr>
              ))}
              {proximosPagos.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 30, textAlign: "center", color: "var(--ink-faint)" }}>No hay pagos futuros programados.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

/* ---- 5.3 Módulo: Créditos (formulario seccionado + grid + panel) ------- */
function FormularioCredito({ inicial, onGuardar, onCancelar }) {
  const { historicoIBR, creditos, configuracion } = useApp();
  const vacio = {
    banco: configuracion.bancos.find((b) => b.activo)?.nombre || "", numeroObligacion: "", descripcion: "",
    valorDesembolsado: "", fechaDesembolso: "", fechaVencimiento: "",
    plazoMeses: "", spread: "", periodicidadIntereses: "Mensual",
    periodicidadCapital: "Mensual", mesesGracia: 0,
    tipoAmortizacion: "capital_constante", estado: "Activo", observaciones: "",
  };
  const [form, setForm] = useState(inicial || vacio);
  const [errores, setErrores] = useState({});
  const tieneGracia = form.tipoAmortizacion === "capital_constante_gracia";
  const bancosSeleccionables = configuracion.bancos.filter((b) => b.activo || b.nombre === form.banco);

  const set = (campo) => (e) => {
    const valor = e && e.target ? e.target.value : e;
    setForm((f) => ({ ...f, [campo]: valor }));
  };

  const ibrAplicada = form.fechaDesembolso ? MotorFinanciero.obtenerIBRVigente(historicoIBR, form.fechaDesembolso) : null;

  const validar = () => {
    const err = {};
    if (!form.banco) err.banco = "Requerido";
    if (!form.numeroObligacion) err.numeroObligacion = "Requerido";
    else if (creditos.some((c) => c.numeroObligacion === form.numeroObligacion && c.id !== inicial?.id)) err.numeroObligacion = "Ya existe un crédito con este número de obligación";
    if (!form.valorDesembolsado || Number(form.valorDesembolsado) <= 0) err.valorDesembolsado = "Debe ser mayor a 0";
    if (!form.fechaDesembolso) err.fechaDesembolso = "Requerido";
    if (!form.fechaVencimiento) err.fechaVencimiento = "Requerido";
    else if (form.fechaVencimiento <= form.fechaDesembolso) err.fechaVencimiento = "Debe ser posterior al desembolso";
    if (!form.plazoMeses || Number(form.plazoMeses) <= 0) err.plazoMeses = "Debe ser mayor a 0";
    if (form.spread === "" || Number(form.spread) < 0) err.spread = "Requerido";
    if (tieneGracia && Number(form.mesesGracia) <= 0) err.mesesGracia = "Defina los meses de gracia";
    setErrores(err);
    return Object.keys(err).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (!validar()) return;
    onGuardar({
      ...form,
      valorDesembolsado: Number(form.valorDesembolsado),
      plazoMeses: Number(form.plazoMeses),
      spread: Number(form.spread),
      mesesGracia: Number(form.mesesGracia) || 0,
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(14,26,43,0.45)", display: "flex", justifyContent: "flex-end", zIndex: 50 }}>
      <form onSubmit={submit} className="sdf-scrollbar" style={{ width: 520, maxWidth: "100%", background: "var(--surface)", height: "100vh", overflowY: "auto", padding: 26, boxShadow: "-8px 0 24px rgba(14,26,43,0.12)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>{inicial ? "Editar crédito" : "Nuevo crédito"}</h2>
          <button type="button" onClick={onCancelar} aria-label="Cerrar formulario" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)" }}><X size={20} /></button>
        </div>

        <SeccionFormulario titulo="Información general">
          <Campo label="Banco" requerido>
            <select style={inputStyle} value={form.banco} onChange={set("banco")}>
              {bancosSeleccionables.map((b) => <option key={b.id} value={b.nombre}>{b.nombre}</option>)}
            </select>
            {errores.banco && <ErrorTexto texto={errores.banco} />}
          </Campo>
          <Campo label="Número de obligación" requerido>
            <input style={inputStyle} value={form.numeroObligacion} onChange={set("numeroObligacion")} placeholder="Ej. 4500-112233" />
            {errores.numeroObligacion && <ErrorTexto texto={errores.numeroObligacion} />}
          </Campo>
          <Campo label="Descripción">
            <input style={inputStyle} value={form.descripcion} onChange={set("descripcion")} placeholder="Ej. Capital de trabajo cosecha 2026" />
          </Campo>
          <Campo label="Estado">
            <select style={inputStyle} value={form.estado} onChange={set("estado")}>
              {ESTADOS_CREDITO.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </Campo>
        </SeccionFormulario>

        <SeccionFormulario titulo="Condiciones del crédito">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Campo label="Valor desembolsado (COP)" requerido>
              <input style={inputStyle} type="number" min="0" value={form.valorDesembolsado} onChange={set("valorDesembolsado")} placeholder="0" />
              {errores.valorDesembolsado && <ErrorTexto texto={errores.valorDesembolsado} />}
            </Campo>
            <Campo label="Plazo (meses)" requerido>
              <input style={inputStyle} type="number" min="1" value={form.plazoMeses} onChange={set("plazoMeses")} placeholder="60" />
              {errores.plazoMeses && <ErrorTexto texto={errores.plazoMeses} />}
            </Campo>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Campo label="Fecha de desembolso" requerido>
              <input style={inputStyle} type="date" value={form.fechaDesembolso} onChange={set("fechaDesembolso")} />
              {errores.fechaDesembolso && <ErrorTexto texto={errores.fechaDesembolso} />}
            </Campo>
            <Campo label="Fecha de vencimiento" requerido>
              <input style={inputStyle} type="date" value={form.fechaVencimiento} onChange={set("fechaVencimiento")} />
              {errores.fechaVencimiento && <ErrorTexto texto={errores.fechaVencimiento} />}
            </Campo>
          </div>
        </SeccionFormulario>

        <SeccionFormulario titulo="Tasas">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Campo label="IBR aplicada" tooltip="Se toma del histórico de IBR según la fecha de desembolso. Es de solo lectura.">
              <input style={inputSoloLecturaStyle} readOnly value={ibrAplicada !== null ? `${formatPct(ibrAplicada)} EA` : "Sin datos para esta fecha"} />
            </Campo>
            <Campo label="Spread fijo (%)" requerido tooltip="Se mantiene constante durante toda la vida del crédito.">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.spread} onChange={set("spread")} placeholder="Ej. 3.25" />
              {errores.spread && <ErrorTexto texto={errores.spread} />}
            </Campo>
          </div>
        </SeccionFormulario>

        <SeccionFormulario titulo="Condiciones de pago">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Campo label="Periodicidad de intereses">
              <select style={inputStyle} value={form.periodicidadIntereses} onChange={set("periodicidadIntereses")}>
                {PERIODICIDADES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Campo>
            <Campo label="Periodicidad de capital">
              <select style={inputStyle} value={form.periodicidadCapital} onChange={set("periodicidadCapital")}>
                {PERIODICIDADES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Campo>
          </div>
          <Campo label="Tipo de amortización" tooltip="Por ahora el sistema solo soporta capital constante. Bullet, cuota fija y personalizada quedan preparados para etapas futuras.">
            <input style={inputSoloLecturaStyle} readOnly value="Capital constante" />
          </Campo>
          <div style={{ margin: "14px 0" }}>
            <Interruptor
              activo={tieneGracia}
              etiqueta="¿Tiene período de gracia?"
              onChange={(v) => setForm((f) => ({ ...f, tipoAmortizacion: v ? "capital_constante_gracia" : "capital_constante" }))}
            />
          </div>
          {tieneGracia && (
            <Campo label="Meses de gracia a capital" requerido hint="Durante la gracia solo se pagan intereses.">
              <input style={inputStyle} type="number" min="1" value={form.mesesGracia} onChange={set("mesesGracia")} placeholder="24" />
              {errores.mesesGracia && <ErrorTexto texto={errores.mesesGracia} />}
            </Campo>
          )}
        </SeccionFormulario>

        <SeccionFormulario titulo="Observaciones" ultima>
          <textarea style={{ ...inputStyle, minHeight: 90, resize: "vertical" }} value={form.observaciones} onChange={set("observaciones")} placeholder="Notas adicionales, garantías, condiciones especiales…" />
        </SeccionFormulario>

        <div style={{ display: "flex", gap: 8, marginTop: 20, position: "sticky", bottom: 0, background: "var(--surface)", paddingTop: 10 }}>
          <Boton type="submit"><Check size={15} /> Guardar crédito</Boton>
          <Boton type="button" variant="ghost" onClick={onCancelar}>Cancelar</Boton>
        </div>
      </form>
    </div>
  );
}

function SeccionFormulario({ titulo, children, ultima }) {
  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0, marginBottom: 18, paddingBottom: ultima ? 0 : 18, borderBottom: ultima ? "none" : "1px solid var(--line-soft)" }}>
      <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--teal-strong)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10, padding: 0 }}>{titulo}</legend>
      {children}
    </fieldset>
  );
}

const COLUMNAS_CREDITO = [
  { key: "banco", label: "Banco" },
  { key: "numeroObligacion", label: "Obligación" },
  { key: "descripcion", label: "Descripción", porDefecto: false },
  { key: "valorDesembolsado", label: "Desembolsado", numerica: true },
  { key: "plazoMeses", label: "Plazo", numerica: true },
  { key: "spread", label: "Spread", numerica: true },
  { key: "fechaVencimiento", label: "Vencimiento", porDefecto: false },
  { key: "estado", label: "Estado" },
];

function SelectorColumnas({ visibles, onCambiar }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <Boton variant="ghost" size="chico" onClick={() => setAbierto((a) => !a)} aria-expanded={abierto}>
        <Columns3 size={14} /> Columnas
      </Boton>
      {abierto && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, boxShadow: "0 8px 20px rgba(14,26,43,0.12)", padding: 10, zIndex: 20, width: 190 }}>
          {COLUMNAS_CREDITO.map((c) => (
            <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "5px 4px", cursor: "pointer" }}>
              <input type="checkbox" checked={visibles.includes(c.key)} onChange={() => onCambiar(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function PanelResumenCredito({ credito, onCerrar, onEditar }) {
  const { historicoIBR } = useApp();
  const resumen = obtenerResumenCredito(credito, historicoIBR);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(14,26,43,0.35)", display: "flex", justifyContent: "flex-end", zIndex: 45 }} onClick={onCerrar}>
      <div className="sdf-scrollbar" style={{ width: 380, background: "var(--surface)", height: "100vh", overflowY: "auto", padding: 24, boxShadow: "-8px 0 24px rgba(14,26,43,0.12)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>{credito.numeroObligacion}</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: "2px 0 6px" }}>{credito.banco}</h2>
            <EstadoBadge estado={credito.estado} />
          </div>
          <button onClick={onCerrar} aria-label="Cerrar panel" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)" }}><X size={20} /></button>
        </div>

        {resumen.errores ? (
          <div style={{ display: "flex", gap: 8, background: "var(--amber-soft)", color: "var(--amber)", padding: "10px 12px", borderRadius: 8, fontSize: 12.5 }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>El motor financiero no pudo calcular este crédito: {resumen.errores[0]}</div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10, marginBottom: 18 }}>
            <FilaResumen label="Saldo actual" valor={formatCOP(resumen.saldoActual)} />
            <FilaResumen label="Próximo pago" valor={resumen.proximoPago ? `${formatFecha(resumen.proximoPago.fecha)} · ${formatCOP(resumen.proximoPago.pagoTotal)}` : "—"} />
            <FilaResumen label="Próximo cambio de IBR" valor={resumen.proximoCambioIBR ? formatFecha(resumen.proximoCambioIBR) : "—"} />
            <FilaResumen label="Fecha de vencimiento" valor={formatFecha(credito.fechaVencimiento)} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Boton onClick={() => onEditar(credito)}><Pencil size={14} /> Editar</Boton>
          <Boton variant="ghost" onClick={onCerrar}>Cerrar</Boton>
        </div>
      </div>
    </div>
  );
}
function FilaResumen({ label, valor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{label}</span>
      <span className="sdf-num" style={{ fontSize: 13, fontWeight: 600 }}>{valor}</span>
    </div>
  );
}

function ModuloCreditos() {
  const { creditos, historicoIBR, crearCredito, actualizarCredito, eliminarCredito, busquedaGlobalPendiente, consumirBusquedaGlobal, creditoAAbrirPendiente, consumirCreditoAAbrir } = useApp();
  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("Todos");
  const [editando, setEditando] = useState(null);
  const [creando, setCreando] = useState(false);
  const [porEliminar, setPorEliminar] = useState(null);
  const [seleccionado, setSeleccionado] = useState(null);
  const [orden, setOrden] = useState({ campo: "banco", dir: "asc" });
  const [columnasVisibles, setColumnasVisibles] = useState(COLUMNAS_CREDITO.filter((c) => c.porDefecto !== false).map((c) => c.key));
  const [importando, setImportando] = useState(false);

  useEffect(() => {
    if (busquedaGlobalPendiente) {
      setBusqueda(busquedaGlobalPendiente);
      consumirBusquedaGlobal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busquedaGlobalPendiente]);

  useEffect(() => {
    if (creditoAAbrirPendiente) {
      const c = creditos.find((c) => c.id === creditoAAbrirPendiente);
      if (c) setSeleccionado(c);
      consumirCreditoAAbrir();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditoAAbrirPendiente]);

  const alternarColumna = (key) => setColumnasVisibles((v) => (v.includes(key) ? v.filter((k) => k !== key) : [...v, key]));

  const alternarOrden = (campo) => setOrden((o) => (o.campo === campo ? { campo, dir: o.dir === "asc" ? "desc" : "asc" } : { campo, dir: "asc" }));

  const filtrados = useMemo(() => {
    let lista = creditos.filter((c) => {
      const coincideTexto = `${c.banco} ${c.numeroObligacion} ${c.descripcion}`.toLowerCase().includes(busqueda.toLowerCase());
      const coincideEstado = filtroEstado === "Todos" || c.estado === filtroEstado;
      return coincideTexto && coincideEstado;
    });
    lista = [...lista].sort((a, b) => {
      const va = a[orden.campo], vb = b[orden.campo];
      const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "es");
      return orden.dir === "asc" ? cmp : -cmp;
    });
    return lista;
  }, [creditos, busqueda, filtroEstado, orden]);

  const { pageItems, pagina, totalPaginas, setPagina } = usePaginacion(filtrados, 8);

  return (
    <>
      <TopBar
        titulo="Créditos" subtitulo="Registro maestro de obligaciones financieras"
        acciones={<>
          <Boton variant="ghost" onClick={() => setImportando(true)}><Upload size={15} /> Importar</Boton>
          <Boton onClick={() => setCreando(true)}><Plus size={15} /> Nuevo crédito</Boton>
        </>}
      />
      <div style={{ padding: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 10, flex: 1, minWidth: 260 }}>
            <div style={{ position: "relative", flex: 1, maxWidth: 320 }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: 11, color: "var(--ink-faint)" }} />
              <input style={{ ...inputStyle, paddingLeft: 30 }} placeholder="Buscar por banco, obligación o descripción" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} aria-label="Buscar crédito" />
            </div>
            <select style={{ ...inputStyle, width: 160 }} value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)} aria-label="Filtrar por estado">
              <option value="Todos">Todos los estados</option>
              {ESTADOS_CREDITO.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <SelectorColumnas visibles={columnasVisibles} onCambiar={alternarColumna} />
            <Boton variant="ghost" size="chico" onClick={() => exportarCreditosExcel(filtrados, historicoIBR, [busqueda && `Búsqueda: "${busqueda}"`, filtroEstado !== "Todos" && `Estado: ${filtroEstado}`].filter(Boolean).join(" · "))}>
              <Download size={14} /> Exportar
            </Boton>
          </div>
        </div>

        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }} className="sdf-scrollbar">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>
                  {COLUMNAS_CREDITO.filter((c) => columnasVisibles.includes(c.key)).map((c) => (
                    <th key={c.key} style={{ ...thStyle, textAlign: c.numerica ? "right" : "left", cursor: "pointer", userSelect: "none" }} onClick={() => alternarOrden(c.key)}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {c.label}
                        {orden.campo === c.key && (orden.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </span>
                    </th>
                  ))}
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((c) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }} onClick={() => setSeleccionado(c)}>
                    {columnasVisibles.includes("banco") && (
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ fontWeight: 600 }}>{c.banco}</div>
                      </td>
                    )}
                    {columnasVisibles.includes("numeroObligacion") && <td style={{ padding: "12px 14px" }} className="sdf-num">{c.numeroObligacion}</td>}
                    {columnasVisibles.includes("descripcion") && <td style={{ padding: "12px 14px", color: "var(--ink-soft)" }}>{c.descripcion || "—"}</td>}
                    {columnasVisibles.includes("valorDesembolsado") && <td style={{ padding: "12px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(c.valorDesembolsado)}</td>}
                    {columnasVisibles.includes("plazoMeses") && <td style={{ padding: "12px 14px", textAlign: "right" }} className="sdf-num">{c.plazoMeses} m</td>}
                    {columnasVisibles.includes("spread") && <td style={{ padding: "12px 14px", textAlign: "right" }} className="sdf-num">{formatPct(c.spread)}</td>}
                    {columnasVisibles.includes("fechaVencimiento") && <td style={{ padding: "12px 14px" }} className="sdf-num">{formatFecha(c.fechaVencimiento)}</td>}
                    {columnasVisibles.includes("estado") && <td style={{ padding: "12px 14px" }}><EstadoBadge estado={c.estado} /></td>}
                    <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setEditando(c)} style={iconBtnStyle} title="Editar" aria-label={`Editar crédito ${c.numeroObligacion}`}><Pencil size={14} /></button>
                      <button onClick={() => setPorEliminar(c)} style={{ ...iconBtnStyle, color: "var(--rose)" }} title="Eliminar" aria-label={`Eliminar crédito ${c.numeroObligacion}`}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
                {pageItems.length === 0 && (
                  <tr><td colSpan={columnasVisibles.length + 1} style={{ padding: 32, textAlign: "center", color: "var(--ink-faint)", fontSize: 13 }}>No hay créditos que coincidan con la búsqueda.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <ControlPaginacion pagina={pagina} totalPaginas={totalPaginas} setPagina={setPagina} total={filtrados.length} />
        </Card>
      </div>

      {(creando || editando) && (
        <FormularioCredito
          inicial={editando}
          onCancelar={() => { setCreando(false); setEditando(null); }}
          onGuardar={(data) => {
            if (editando) actualizarCredito(editando.id, data);
            else crearCredito(data);
            setCreando(false); setEditando(null); setSeleccionado(null);
          }}
        />
      )}

      {seleccionado && !editando && (
        <PanelResumenCredito credito={seleccionado} onCerrar={() => setSeleccionado(null)} onEditar={(c) => { setEditando(c); setSeleccionado(null); }} />
      )}

      {porEliminar && (
        <ConfirmarEliminacion
          titulo={`¿Eliminar el crédito ${porEliminar.numeroObligacion}?`}
          descripcion="Esta acción no se puede deshacer."
          onCancelar={() => setPorEliminar(null)}
          onConfirmar={() => { eliminarCredito(porEliminar.id); setPorEliminar(null); }}
        />
      )}

      {importando && <AsistenteImportar tipo="creditos" onCerrar={() => setImportando(false)} />}
    </>
  );
}

/* ---- 5.4 Módulo: IBR ---------------------------------------------------- */
function ModuloIBR() {
  const { historicoIBR, creditos, agregarTasaIBR, eliminarTasaIBR } = useApp();
  const [fecha, setFecha] = useState("");
  const [valor, setValor] = useState("");
  const [errores, setErrores] = useState({});
  const [porEliminar, setPorEliminar] = useState(null);
  const [importando, setImportando] = useState(false);

  const ordenado = [...historicoIBR].sort((a, b) => b.fecha.localeCompare(a.fecha));
  const vigente = historicoIBR.length ? historicoIBR[historicoIBR.length - 1] : null;

  const agregar = (e) => {
    e.preventDefault();
    const err = {};
    if (!fecha) err.fecha = "Requerido";
    if (valor === "" || Number(valor) < 0) err.valor = "Requerido";
    if (historicoIBR.some((t) => t.fecha === fecha)) err.fecha = "Ya existe una tasa para esta fecha";
    setErrores(err);
    if (Object.keys(err).length) return;
    agregarTasaIBR({ fecha, valorEA: Number(valor), fuente: "Manual" });
    setFecha(""); setValor("");
  };

  const solicitarEliminar = (tasa) => {
    const { enUso, credito } = tasaEstaEnUso(tasa, creditos, historicoIBR);
    setPorEliminar({ tasa, enUso, credito });
  };

  return (
    <>
      <TopBar titulo="IBR" subtitulo="Histórico de tasas — nunca se recalculan períodos anteriores con una tasa distinta" />
      <div style={{ padding: 32 }}>
        <Card style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Tasa vigente</div>
            <div className="sdf-num" style={{ fontSize: 22, fontWeight: 700 }}>{vigente ? `${formatPct(vigente.valorEA)} EA` : "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Última actualización</div>
            <div className="sdf-num" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-soft)" }}>{vigente ? formatFecha(vigente.fecha) : "—"}</div>
          </div>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20, alignItems: "start" }}>
          <Card>
            <strong style={{ fontSize: 14, display: "block", marginBottom: 14 }}>Cargar tasa IBR</strong>
            <form onSubmit={agregar}>
              <Campo label="Fecha" requerido>
                <input style={inputStyle} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
                {errores.fecha && <ErrorTexto texto={errores.fecha} />}
              </Campo>
              <Campo label="Valor IBR E.A. (%)" requerido>
                <input style={inputStyle} type="number" step="0.0001" min="0" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="Ej. 9.61" />
                {errores.valor && <ErrorTexto texto={errores.valor} />}
              </Campo>
              <Boton type="submit" style={{ width: "100%", justifyContent: "center" }}><Plus size={15} /> Agregar tasa</Boton>
            </form>
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 8 }}>Importar desde Excel</div>
              <button type="button" onClick={() => setImportando(true)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px 12px", borderRadius: 7, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 12.5, cursor: "pointer" }}>
                <Upload size={14} /> Importar tasas desde Excel
              </button>
            </div>
          </Card>

          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
              <Boton variant="ghost" size="chico" onClick={() => exportarIBRExcel(historicoIBR)}><Download size={13} /> Exportar</Boton>
            </div>
            <div style={{ overflowX: "auto" }} className="sdf-scrollbar">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>
                    <th style={thStyle}>Fecha</th><th style={{ ...thStyle, textAlign: "right" }}>Valor E.A.</th><th style={thStyle}>Fuente</th><th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {ordenado.map((t) => (
                    <tr key={t.id} style={{ borderBottom: "1px solid var(--line-soft)", background: t.id === vigente?.id ? "var(--teal-soft)" : "transparent" }}>
                      <td style={{ padding: "11px 14px" }} className="sdf-num">{formatFecha(t.fecha)} {t.id === vigente?.id && <span style={{ fontSize: 10, color: "var(--teal-strong)", fontWeight: 700, marginLeft: 4 }}>VIGENTE</span>}</td>
                      <td style={{ padding: "11px 14px", textAlign: "right" }} className="sdf-num">{formatPct(t.valorEA)}</td>
                      <td style={{ padding: "11px 14px", color: "var(--ink-soft)" }}>{t.fuente}</td>
                      <td style={{ padding: "11px 14px", textAlign: "right" }}>
                        <button onClick={() => solicitarEliminar(t)} style={{ ...iconBtnStyle, color: "var(--rose)" }} title="Eliminar" aria-label={`Eliminar tasa del ${formatFecha(t.fecha)}`}><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  ))}
                  {ordenado.length === 0 && <tr><td colSpan={4} style={{ padding: 32, textAlign: "center", color: "var(--ink-faint)" }}>Aún no hay tasas cargadas.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      {porEliminar && (
        <ConfirmarEliminacion
          titulo={`¿Eliminar la tasa del ${formatFecha(porEliminar.tasa.fecha)}?`}
          descripcion="Esta acción no se puede deshacer."
          advertencia={porEliminar.enUso ? `Esta tasa ya fue utilizada por el crédito ${porEliminar.credito.numeroObligacion} (${porEliminar.credito.banco}) en al menos un período de intereses. Eliminarla puede volver ese cálculo inconsistente.` : null}
          textoConfirmar={porEliminar.enUso ? "Eliminar de todos modos" : "Eliminar"}
          onCancelar={() => setPorEliminar(null)}
          onConfirmar={() => { eliminarTasaIBR(porEliminar.tasa.id); setPorEliminar(null); }}
        />
      )}

      {importando && <AsistenteImportar tipo="ibr" onCerrar={() => setImportando(false)} />}
    </>
  );
}

/* ---- Filtros comunes para Cronograma / Causación / Flujo --------------- */
function useFiltrosCredito(creditos) {
  const [creditoId, setCreditoId] = useState("todos");
  const [banco, setBanco] = useState("todos");
  const [anio, setAnio] = useState("todos");
  const bancos = useMemo(() => Array.from(new Set(creditos.map((c) => c.banco))), [creditos]);
  const creditosFiltrados = useMemo(
    () => creditos.filter((c) => (creditoId === "todos" || c.id === creditoId) && (banco === "todos" || c.banco === banco)),
    [creditos, creditoId, banco]
  );
  return { creditoId, setCreditoId, banco, setBanco, anio, setAnio, bancos, creditosFiltrados };
}

function BarraFiltros({ creditos, filtros, mostrarAnio = true, anios }) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
      <select style={{ ...inputStyle, width: 220 }} value={filtros.creditoId} onChange={(e) => filtros.setCreditoId(e.target.value)} aria-label="Filtrar por crédito">
        <option value="todos">Todos los créditos</option>
        {creditos.map((c) => <option key={c.id} value={c.id}>{c.banco} — {c.numeroObligacion}</option>)}
      </select>
      <select style={{ ...inputStyle, width: 160 }} value={filtros.banco} onChange={(e) => filtros.setBanco(e.target.value)} aria-label="Filtrar por banco">
        <option value="todos">Todos los bancos</option>
        {filtros.bancos.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      {mostrarAnio && (
        <select style={{ ...inputStyle, width: 130 }} value={filtros.anio} onChange={(e) => filtros.setAnio(e.target.value)} aria-label="Filtrar por año">
          <option value="todos">Todos los años</option>
          {anios.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      )}
    </div>
  );
}

/* ---- 5.5 Módulo: Cronograma --------------------------------------------- */
const ETIQUETA_EVENTO = {
  DESEMBOLSO: "Desembolso", PAGO_INTERES: "Pago de intereses", PAGO_CAPITAL: "Pago de capital",
  "PAGO_INTERES+PAGO_CAPITAL+PAGO_CONJUNTO": "Pago conjunto", VENCIMIENTO: "Vencimiento", PERIODO: "Período",
};
function etiquetaEvento(tipo) {
  if (tipo.includes("PAGO_CONJUNTO")) return "Pago conjunto";
  return ETIQUETA_EVENTO[tipo] || tipo;
}

function ModuloCronograma() {
  const { creditos, historicoIBR } = useApp();
  const filtros = useFiltrosCredito(creditos);
  const [expandidas, setExpandidas] = useState(new Set());

  const { cargando, valor: datos } = useCalculoConCarga(() => {
    const errores = [];
    let filas = [];
    filtros.creditosFiltrados.forEach((credito) => {
      const r = MotorFinanciero.calcularCronograma(credito, historicoIBR);
      if (r.errores.length) errores.push({ credito, errores: r.errores });
      else filas = filas.concat(r.filas.map((f) => ({ ...f, credito })));
    });
    filas.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
    return { filas, errores };
  }, [filtros.creditosFiltrados, historicoIBR]);

  const filas = datos?.filas || [];
  const erroresCalculo = datos?.errores || [];
  const anios = useMemo(() => Array.from(new Set(filas.map((f) => anioDe(f.fecha)))).sort(), [filas]);
  const filasAnio = filtros.anio === "todos" ? filas : filas.filter((f) => anioDe(f.fecha) === Number(filtros.anio));
  const { pageItems, pagina, totalPaginas, setPagina } = usePaginacion(filasAnio, 20);

  const alternarExpandir = (key) => setExpandidas((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const creditoSeleccionado = creditos.find((c) => c.id === filtros.creditoId);
  const textoFiltros = [
    creditoSeleccionado && `Crédito: ${creditoSeleccionado.banco} — ${creditoSeleccionado.numeroObligacion}`,
    filtros.banco !== "todos" && `Banco: ${filtros.banco}`,
    filtros.anio !== "todos" && `Año: ${filtros.anio}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <TopBar
        titulo="Cronograma" subtitulo="Cronograma financiero generado por el motor — vista de caja"
        acciones={<Boton variant="ghost" onClick={() => exportarCronogramaExcel(filasAnio, textoFiltros)}><Download size={15} /> Exportar a Excel</Boton>}
      />
      <div style={{ padding: 32 }}>
        <BarraFiltros creditos={creditos} filtros={filtros} anios={anios} />

        {erroresCalculo.length > 0 && (
          <Card style={{ marginBottom: 16, background: "var(--amber-soft)", border: "1px solid #EAD3B0" }}>
            {erroresCalculo.map(({ credito, errores }) => (
              <div key={credito.id} style={{ fontSize: 12.5, color: "var(--ink)", display: "flex", gap: 8 }}>
                <AlertTriangle size={14} color="var(--amber)" style={{ flexShrink: 0, marginTop: 1 }} />
                <span><strong>{credito.banco} — {credito.numeroObligacion}:</strong> {errores[0]}</span>
              </div>
            ))}
          </Card>
        )}

        <Card style={{ padding: 0, overflow: "hidden" }}>
          {cargando ? <Spinner etiqueta="Calculando cronograma…" /> : (
            <>
              <div style={{ overflowX: "auto" }} className="sdf-scrollbar">
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>
                      <th style={thStyle}></th>
                      <th style={thStyle}>Fecha</th><th style={thStyle}>Crédito</th><th style={thStyle}>Tipo de evento</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Saldo inicial</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>IBR</th><th style={{ ...thStyle, textAlign: "right" }}>Spread</th><th style={{ ...thStyle, textAlign: "right" }}>Tasa total</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Interés</th><th style={{ ...thStyle, textAlign: "right" }}>Capital</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Pago total</th><th style={{ ...thStyle, textAlign: "right" }}>Saldo final</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((f, i) => {
                      const key = `${f.credito.id}-${f.fecha}-${i}`;
                      const expandida = expandidas.has(key);
                      const esFilaMesActual = mesDe(f.fecha) === mesActualISO();
                      return (
                        <React.Fragment key={key}>
                          <tr style={{ borderBottom: "1px solid var(--line-soft)", background: esFilaMesActual ? "var(--teal-soft)" : "transparent", cursor: "pointer" }} onClick={() => alternarExpandir(key)}>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>{expandida ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                            <td style={{ padding: "10px 14px" }} className="sdf-num">{formatFecha(f.fecha)}</td>
                            <td style={{ padding: "10px 14px" }}>{f.credito.banco}<div style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{f.credito.numeroObligacion}</div></td>
                            <td style={{ padding: "10px 14px" }}>{etiquetaEvento(f.tipoEvento)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.capitalInicial)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatPct(f.ibrAplicada)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatPct(f.spread)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatPct(f.tasaTotal)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.interes)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.capitalPagado)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right", fontWeight: 600 }} className="sdf-num">{formatCOP(f.pagoTotal)}</td>
                            <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.saldo)}</td>
                          </tr>
                          {expandida && (
                            <tr style={{ background: "var(--paper)" }}>
                              <td></td>
                              <td colSpan={11} style={{ padding: "10px 14px", fontSize: 12, color: "var(--ink-soft)" }}>
                                {f.diasFinancieros !== undefined ? (
                                  <span className="sdf-num">
                                    Interés = {formatCOP(f.capitalInicial)} × {formatPct(f.tasaTotal)} × ({f.diasFinancieros} días / 360) = {formatCOP(f.interes || (f.capitalInicial * (f.tasaTotal / 100) * (f.diasFinancieros / 360)))}
                                  </span>
                                ) : "Fila de desembolso — no aplica cálculo de interés."}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {pageItems.length === 0 && <tr><td colSpan={12} style={{ padding: 30, textAlign: "center", color: "var(--ink-faint)" }}>No hay filas para los filtros seleccionados.</td></tr>}
                  </tbody>
                </table>
              </div>
              <ControlPaginacion pagina={pagina} totalPaginas={totalPaginas} setPagina={setPagina} total={filasAnio.length} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/* ---- 5.6 Módulo: Distribución Contable (Causación) ---------------------- */
function ModuloCausacion() {
  const { creditos, historicoIBR } = useApp();
  const filtros = useFiltrosCredito(creditos);

  const { cargando, valor: datos } = useCalculoConCarga(() => {
    const errores = [];
    let filas = [];
    filtros.creditosFiltrados.forEach((credito) => {
      const r = MotorFinanciero.calcularCausacion(credito, historicoIBR);
      if (r.errores.length) errores.push({ credito, errores: r.errores });
      else filas = filas.concat(r.filas.map((f) => ({ ...f, credito })));
    });
    filas.sort((a, b) => (a.mesContable < b.mesContable ? -1 : a.mesContable > b.mesContable ? 1 : 0));
    return { filas, errores };
  }, [filtros.creditosFiltrados, historicoIBR]);

  const filas = datos?.filas || [];
  const erroresCalculo = datos?.errores || [];
  const anios = useMemo(() => Array.from(new Set(filas.map((f) => Number(f.mesContable.slice(0, 4))))).sort(), [filas]);
  const filasAnio = filtros.anio === "todos" ? filas : filas.filter((f) => Number(f.mesContable.slice(0, 4)) === Number(filtros.anio));
  const { pageItems, pagina, totalPaginas, setPagina } = usePaginacion(filasAnio, 20);

  const totalCausado = filasAnio.reduce((s, f) => s + f.interesCausado, 0);
  const totalPagado = filasAnio.reduce((s, f) => s + f.interesPagado, 0);

  const creditoSeleccionado = creditos.find((c) => c.id === filtros.creditoId);
  const textoFiltros = [
    creditoSeleccionado && `Crédito: ${creditoSeleccionado.banco} — ${creditoSeleccionado.numeroObligacion}`,
    filtros.banco !== "todos" && `Banco: ${filtros.banco}`,
    filtros.anio !== "todos" && `Año: ${filtros.anio}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <TopBar
        titulo="Causación" subtitulo="Distribución contable mensual del interés — generada por el motor financiero"
        acciones={<Boton variant="ghost" onClick={() => exportarCausacionExcel(filasAnio, textoFiltros)}><Download size={15} /> Exportar a Excel</Boton>}
      />
      <div style={{ padding: 32 }}>
        <BarraFiltros creditos={creditos} filtros={filtros} anios={anios} />

        {erroresCalculo.length > 0 && (
          <Card style={{ marginBottom: 16, background: "var(--amber-soft)", border: "1px solid #EAD3B0" }}>
            {erroresCalculo.map(({ credito, errores }) => (
              <div key={credito.id} style={{ fontSize: 12.5, display: "flex", gap: 8 }}>
                <AlertTriangle size={14} color="var(--amber)" style={{ flexShrink: 0, marginTop: 1 }} />
                <span><strong>{credito.banco} — {credito.numeroObligacion}:</strong> {errores[0]}</span>
              </div>
            ))}
          </Card>
        )}

        <Card style={{ padding: 0, overflow: "hidden" }}>
          {cargando ? <Spinner etiqueta="Calculando causación…" /> : (
            <>
              <div style={{ overflowX: "auto" }} className="sdf-scrollbar">
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>
                      <th style={thStyle}>Mes</th><th style={thStyle}>Crédito</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Días financieros</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Interés causado</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Interés acumulado</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Interés pagado</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Saldo pendiente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((f, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                        <td style={{ padding: "10px 14px" }} className="sdf-num">{nombreMes(f.mesContable)}</td>
                        <td style={{ padding: "10px 14px" }}>{f.credito.banco}<div style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{f.credito.numeroObligacion}</div></td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatNumero(f.diasFinancieros)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.interesCausado)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.interesAcumulado)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.interesPagado)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.saldoPendienteCausar)}</td>
                      </tr>
                    ))}
                    {pageItems.length === 0 && <tr><td colSpan={7} style={{ padding: 30, textAlign: "center", color: "var(--ink-faint)" }}>No hay causación para los filtros seleccionados.</td></tr>}
                  </tbody>
                  {filasAnio.length > 0 && (
                    <tfoot>
                      <tr style={{ borderTop: "2px solid var(--line)", background: "var(--paper)", fontWeight: 700 }}>
                        <td style={{ padding: "10px 14px" }} colSpan={3}>Total del período filtrado</td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(totalCausado)}</td>
                        <td></td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(totalPagado)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <ControlPaginacion pagina={pagina} totalPaginas={totalPaginas} setPagina={setPagina} total={filasAnio.length} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/* ---- 5.7 Módulo: Flujo de Caja ------------------------------------------ */
function ModuloFlujo() {
  const { creditos, historicoIBR, flujoMesPendiente, consumirFlujoMesPendiente } = useApp();
  const filtros = useFiltrosCredito(creditos);
  const [mes, setMes] = useState("todos");

  useEffect(() => {
    if (flujoMesPendiente) {
      setMes(flujoMesPendiente);
      consumirFlujoMesPendiente();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flujoMesPendiente]);

  const { cargando, valor: filasBase } = useCalculoConCarga(() => {
    const { filas } = MotorFinanciero.calcularFlujoCaja(filtros.creditosFiltrados, historicoIBR);
    return filas;
  }, [filtros.creditosFiltrados, historicoIBR]);

  const filas = filasBase || [];
  const anios = useMemo(() => Array.from(new Set(filas.map((f) => anioDe(f.fecha)))).sort(), [filas]);
  const filasFiltradas = filas.filter((f) => (filtros.anio === "todos" || anioDe(f.fecha) === Number(filtros.anio)) && (mes === "todos" || mesDe(f.fecha) === mes));

  const grupos = useMemo(() => {
    const mapa = new Map();
    filasFiltradas.forEach((f) => {
      const key = mesDe(f.fecha);
      if (!mapa.has(key)) mapa.set(key, []);
      mapa.get(key).push(f);
    });
    return Array.from(mapa.keys()).sort().map((key) => ({ mes: key, filas: mapa.get(key) }));
  }, [filasFiltradas]);

  const mesesDisponibles = useMemo(() => Array.from(new Set(filas.map((f) => mesDe(f.fecha)))).sort(), [filas]);

  const creditoSeleccionado = creditos.find((c) => c.id === filtros.creditoId);
  const textoFiltros = [
    creditoSeleccionado && `Crédito: ${creditoSeleccionado.banco} — ${creditoSeleccionado.numeroObligacion}`,
    filtros.banco !== "todos" && `Banco: ${filtros.banco}`,
    filtros.anio !== "todos" && `Año: ${filtros.anio}`,
    mes !== "todos" && `Mes: ${nombreMes(mes)}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <TopBar
        titulo="Flujo de Caja" subtitulo="Pagos futuros consolidados de todos los créditos — generado por el motor financiero"
        acciones={<Boton variant="ghost" onClick={() => exportarFlujoExcel(filasFiltradas, textoFiltros)}><Download size={15} /> Exportar a Excel</Boton>}
      />
      <div style={{ padding: 32 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <BarraFiltros creditos={creditos} filtros={filtros} mostrarAnio anios={anios} />
          <select style={{ ...inputStyle, width: 170 }} value={mes} onChange={(e) => setMes(e.target.value)} aria-label="Filtrar por mes">
            <option value="todos">Todos los meses</option>
            {mesesDisponibles.map((m) => <option key={m} value={m}>{nombreMes(m)}</option>)}
          </select>
        </div>

        {cargando ? <Card><Spinner etiqueta="Calculando flujo de caja…" /></Card> : (
          <div style={{ display: "grid", gap: 16 }}>
            {grupos.map((g) => {
              const esMesActual = g.mes === mesActualISO();
              const subtotal = g.filas.reduce((s, f) => s + f.pagoTotal, 0);
              return (
                <Card key={g.mes} style={{ padding: 0, overflow: "hidden", border: esMesActual ? "1.5px solid var(--teal)" : "1px solid var(--line)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: esMesActual ? "var(--teal-soft)" : "var(--paper)", borderBottom: "1px solid var(--line)" }}>
                    <strong style={{ fontSize: 13.5, textTransform: "capitalize" }}>{nombreMes(g.mes)} {esMesActual && <span style={{ fontSize: 10.5, color: "var(--teal-strong)", fontWeight: 700, marginLeft: 6 }}>MES ACTUAL</span>}</strong>
                    <span className="sdf-num" style={{ fontSize: 13, fontWeight: 700 }}>Subtotal: {formatCOP(subtotal)}</span>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "var(--paper)" }}>
                        <th style={thStyle}>Fecha</th><th style={thStyle}>Banco</th><th style={thStyle}>Obligación</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Capital</th><th style={{ ...thStyle, textAlign: "right" }}>Intereses</th><th style={{ ...thStyle, textAlign: "right" }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.filas.map((f, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)", background: f.fecha === hoyISO() ? "var(--amber-soft)" : "transparent" }}>
                          <td style={{ padding: "9px 14px" }} className="sdf-num">{formatFecha(f.fecha)}</td>
                          <td style={{ padding: "9px 14px" }}>{f.banco}</td>
                          <td style={{ padding: "9px 14px" }} className="sdf-num">{f.numeroObligacion}</td>
                          <td style={{ padding: "9px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.pagoCapital)}</td>
                          <td style={{ padding: "9px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.pagoIntereses)}</td>
                          <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600 }} className="sdf-num">{formatCOP(f.pagoTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              );
            })}
            {grupos.length === 0 && <Card style={{ textAlign: "center", color: "var(--ink-faint)", padding: 40 }}>No hay pagos para los filtros seleccionados.</Card>}
          </div>
        )}
      </div>
    </>
  );
}

/* ---- 5.9 Dashboard Ejecutivo --------------------------------------------
   Todo lo que se muestra aquí proviene de MotorFinanciero.procesarCredito /
   calcularFlujoCaja / obtenerIBRVigente. Esta sección solo AGREGA y RESUME
   esos resultados (sumas, agrupaciones por banco/año/mes, promedios
   ponderados) — no recalcula intereses, amortización ni tasas: eso sigue
   siendo responsabilidad exclusiva del motor. Como el hook useMemo/useEffect
   recalcula cada vez que cambian `creditos` o `historicoIBR` (estado del
   contexto), el Dashboard se actualiza solo cuando se crea/edita un crédito
   o se registra una tasa IBR nueva. --------------------------------------- */

const COLORES_DONA = ["#0C7C6B", "#3ED9B8", "#B8763A", "#27405F", "#B23A34", "#7C8CA6", "#95C9BC", "#D9A15C"];

function mesesEntre(fechaAISO, fechaBISO) {
  const a = parseISO(fechaAISO), b = parseISO(fechaBISO);
  return (b.y - a.y) * 12 + (b.m - a.m) + (b.d - a.d) / 30;
}
function diasEntreFechas(aISO, bISO) {
  return Math.round((new Date(bISO) - new Date(aISO)) / 86400000);
}

// Agregador central del Dashboard: recorre los créditos filtrados, le pide a
// MotorFinanciero el procesamiento de cada uno, y arma tarjetas, gráficos,
// calendario, tablas y alertas a partir de esos resultados.
function calcularDatosDashboard(creditosFiltrados, historicoIBR) {
  const hoy = hoyISO();

  const procesados = creditosFiltrados.map((credito) => {
    try {
      const { cronograma, causacion, eventosInfo } = MotorFinanciero.procesarCredito(credito, historicoIBR);
      const transcurridas = cronograma.filter((f) => f.fecha <= hoy);
      const saldoActual = transcurridas.length ? transcurridas[transcurridas.length - 1].saldo : Number(credito.valorDesembolsado);
      const ibrHoy = MotorFinanciero.obtenerIBRVigente(historicoIBR, hoy);
      const tasaActual = ibrHoy !== null ? ibrHoy + Number(credito.spread) : null;
      return { credito, cronograma, causacion, eventosInfo, saldoActual, tasaActual, error: null };
    } catch (e) {
      return { credito, cronograma: [], causacion: [], eventosInfo: null, saldoActual: null, tasaActual: null, error: e.errores || [e.message] };
    }
  });

  const validos = procesados.filter((p) => !p.error);
  const saldoTotal = validos.reduce((s, p) => s + p.saldoActual, 0);
  const numActivos = creditosFiltrados.filter((c) => c.estado === "Activo" || c.estado === "En gracia").length;
  const numGracia = creditosFiltrados.filter((c) => c.estado === "En gracia").length;

  const sumaPonderada = validos.reduce((s, p) => s + (p.tasaActual !== null ? p.saldoActual * p.tasaActual : 0), 0);
  const basePonderada = validos.reduce((s, p) => s + (p.tasaActual !== null ? p.saldoActual : 0), 0);
  const tasaPromedioPonderada = basePonderada > 0 ? sumaPonderada / basePonderada : null;

  const { filas: flujoTodo } = MotorFinanciero.calcularFlujoCaja(creditosFiltrados, historicoIBR);
  const flujoFuturo = flujoTodo.filter((f) => f.fecha >= hoy);
  const proximoPago = flujoFuturo[0] || null;

  const flujoMesActual = flujoTodo.filter((f) => mesDe(f.fecha) === mesActualISO());
  const capitalMes = flujoMesActual.reduce((s, f) => s + f.pagoCapital, 0);
  const interesesMes = flujoMesActual.reduce((s, f) => s + f.pagoIntereses, 0);
  const pagoTotalMes = capitalMes + interesesMes;

  const bancoMap = new Map();
  validos.forEach((p) => bancoMap.set(p.credito.banco, (bancoMap.get(p.credito.banco) || 0) + p.saldoActual));
  const deudaPorBanco = Array.from(bancoMap.entries())
    .map(([banco, saldo]) => ({ banco, saldo, participacion: saldoTotal > 0 ? (saldo / saldoTotal) * 100 : 0 }))
    .sort((a, b) => b.saldo - a.saldo);

  const anioMap = new Map();
  validos.forEach((p) => { const a = anioDe(p.credito.fechaVencimiento); anioMap.set(a, (anioMap.get(a) || 0) + p.saldoActual); });
  const deudaPorAnio = Array.from(anioMap.entries()).map(([anio, saldo]) => ({ anio: String(anio), saldo })).sort((a, b) => a.anio.localeCompare(b.anio));

  const flujoMapa = new Map();
  flujoFuturo.forEach((f) => {
    const key = mesDe(f.fecha);
    if (!flujoMapa.has(key)) flujoMapa.set(key, { mes: key, capital: 0, intereses: 0, total: 0 });
    const r = flujoMapa.get(key);
    r.capital += f.pagoCapital; r.intereses += f.pagoIntereses; r.total += f.pagoTotal;
  });
  const flujoProyectado = Array.from(flujoMapa.values()).sort((a, b) => a.mes.localeCompare(b.mes));

  const todosLosMeses = Array.from(new Set([mesActualISO(), ...flujoProyectado.map((f) => f.mes)])).sort();
  const evolucionSaldo = todosLosMeses.map((mes) => {
    const finMes = `${mes}-31`; // cota superior; la comparación de texto es válida aunque el mes tenga menos días
    let total = 0;
    validos.forEach((p) => {
      const filas = p.cronograma.filter((f) => f.fecha <= finMes);
      total += filas.length ? filas[filas.length - 1].saldo : Number(p.credito.valorDesembolsado);
    });
    return { mes, saldo: total };
  });

  const calendarioMapa = new Map();
  flujoTodo.forEach((f) => {
    if (!calendarioMapa.has(f.fecha)) calendarioMapa.set(f.fecha, []);
    calendarioMapa.get(f.fecha).push(f);
  });

  const en12Meses = sumarMeses(hoy, 12);
  const proximosAVencer = creditosFiltrados.filter((c) => c.fechaVencimiento >= hoy && c.fechaVencimiento <= en12Meses);

  const conGracia = validos
    .filter((p) => p.credito.tipoAmortizacion === "capital_constante_gracia" && p.eventosInfo)
    .map((p) => ({ credito: p.credito, finGracia: p.eventosInfo.inicioAmortizacion, primeraAmortizacion: p.eventosInfo.fechasCapital[0] || null }));

  const alertas = [];
  flujoFuturo.forEach((f) => {
    const dias = diasEntreFechas(hoy, f.fecha);
    if (dias <= 30) {
      alertas.push({ prioridad: dias <= 7 ? "Alta" : dias <= 15 ? "Media" : "Baja", tipo: "pago", texto: `Pago de ${formatCOP(f.pagoTotal)} el ${formatFecha(f.fecha)} — ${f.banco} (${f.numeroObligacion})` });
    }
  });
  proximosAVencer.forEach((c) => {
    const meses = diasEntreFechas(hoy, c.fechaVencimiento) / 30;
    alertas.push({ prioridad: meses <= 3 ? "Alta" : meses <= 6 ? "Media" : "Baja", tipo: "vencimiento", texto: `El crédito ${c.numeroObligacion} (${c.banco}) vence el ${formatFecha(c.fechaVencimiento)}` });
  });
  conGracia.forEach(({ credito, finGracia }) => {
    if (finGracia >= hoy) {
      const dias = diasEntreFechas(hoy, finGracia);
      if (dias <= 60) alertas.push({ prioridad: dias <= 30 ? "Alta" : "Media", tipo: "gracia", texto: `El período de gracia de ${credito.numeroObligacion} (${credito.banco}) termina el ${formatFecha(finGracia)}` });
    }
  });
  validos.forEach((p) => {
    const siguiente = p.eventosInfo.fechasIntereses.find((f) => f > hoy);
    if (siguiente && MotorFinanciero.obtenerIBRVigente(historicoIBR, siguiente) === null) {
      alertas.push({ prioridad: "Alta", tipo: "ibr", texto: `${p.credito.numeroObligacion} (${p.credito.banco}) no tiene IBR registrada para su siguiente período de intereses (${formatFecha(siguiente)})` });
    }
  });
  const ordenPrioridad = { Alta: 0, Media: 1, Baja: 2 };
  alertas.sort((a, b) => ordenPrioridad[a.prioridad] - ordenPrioridad[b.prioridad]);

  const interesesFuturosProyectados = validos.reduce((s, p) => s + p.causacion.filter((c) => c.mesContable >= mesActualISO()).reduce((s2, c) => s2 + c.interesCausado, 0), 0);
  const pagoPromedioMensual = flujoProyectado.length ? flujoProyectado.reduce((s, f) => s + f.total, 0) / flujoProyectado.length : 0;
  const sumaVida = validos.reduce((s, p) => s + p.saldoActual * Math.max(0, mesesEntre(hoy, p.credito.fechaVencimiento)), 0);
  const vidaPromedioMeses = saldoTotal > 0 ? sumaVida / saldoTotal : 0;

  return {
    procesados, validos, saldoTotal, numActivos, numGracia, tasaPromedioPonderada, proximoPago,
    capitalMes, interesesMes, pagoTotalMes, deudaPorBanco, deudaPorAnio, flujoProyectado,
    evolucionSaldo, calendarioMapa, proximosAVencer, conGracia, alertas, flujoFuturo,
    interesesFuturosProyectados, pagoPromedioMensual, vidaPromedioMeses,
  };
}

function TooltipGrafico({ active, payload, label, formateador }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 11px", fontSize: 12, boxShadow: "0 6px 16px rgba(14,26,43,0.14)" }}>
      {label && <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="sdf-num" style={{ color: p.color, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>{p.name}:</span><span>{formateador ? formateador(p.value, p.name) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

function TarjetaDashboard({ label, valor, sub, icono: Icono, onClick }) {
  return (
    <Card
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icono size={14} color="var(--teal)" />
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{label}</div>
      </div>
      <div className="sdf-num" style={{ fontSize: 19, fontWeight: 700, color: "var(--ink)" }}>{valor}</div>
      {sub && <div className="sdf-num" style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 2 }}>{sub}</div>}
    </Card>
  );
}

const BADGE_PRIORIDAD = {
  Alta: { bg: "var(--rose-soft)", fg: "var(--rose)" },
  Media: { bg: "var(--amber-soft)", fg: "var(--amber)" },
  Baja: { bg: "var(--teal-soft)", fg: "var(--teal-strong)" },
};
function BadgePrioridad({ prioridad }) {
  const s = BADGE_PRIORIDAD[prioridad];
  return <span style={{ background: s.bg, color: s.fg, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 20 }}>{prioridad}</span>;
}

function CalendarioPagos({ mesISO, onCambiarMes, calendarioMapa, onSeleccionarDia, diaSeleccionado }) {
  const [anio, mes] = mesISO.split("-").map(Number);
  const totalDias = diasEnMesCalendario(anio, mes);
  const primerDiaJs = new Date(Date.UTC(anio, mes - 1, 1)).getUTCDay();
  const offset = (primerDiaJs + 6) % 7;
  const celdas = Array(offset).fill(null).concat(Array.from({ length: totalDias }, (_, i) => i + 1));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <button onClick={() => onCambiarMes(sumarMeses(`${mesISO}-01`, -1).slice(0, 7))} style={iconBtnStyle} aria-label="Mes anterior"><ChevronLeft size={14} /></button>
        <strong style={{ textTransform: "capitalize", fontSize: 13.5 }}>{nombreMes(mesISO)}</strong>
        <button onClick={() => onCambiarMes(sumarMeses(`${mesISO}-01`, 1).slice(0, 7))} style={iconBtnStyle} aria-label="Mes siguiente"><ChevronRight size={14} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, fontSize: 10.5, color: "var(--ink-faint)", marginBottom: 4, textAlign: "center" }}>
        {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {celdas.map((d, i) => {
          if (d === null) return <div key={i} />;
          const fechaISO = `${mesISO}-${pad2(d)}`;
          const eventos = calendarioMapa.get(fechaISO) || [];
          const esHoy = fechaISO === hoyISO();
          const seleccionado = fechaISO === diaSeleccionado;
          return (
            <button
              key={i}
              onClick={() => eventos.length && onSeleccionarDia(fechaISO, eventos)}
              className="sdf-focus"
              style={{
                minHeight: 58, border: seleccionado ? "1.5px solid var(--teal)" : esHoy ? "1.5px solid var(--navy-700)" : "1px solid var(--line-soft)",
                borderRadius: 6, padding: 4, background: eventos.length ? "var(--teal-soft)" : "var(--surface)",
                cursor: eventos.length ? "pointer" : "default", textAlign: "left", display: "flex", flexDirection: "column", gap: 2,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: esHoy ? "var(--teal-strong)" : "var(--ink-soft)" }}>{d}</span>
              {eventos.slice(0, 2).map((e, idx) => (
                <span key={idx} className="sdf-num" style={{ fontSize: 9, color: "var(--teal-strong)" }}>{formatCOP(e.pagoTotal)}</span>
              ))}
              {eventos.length > 2 && <span style={{ fontSize: 9, color: "var(--ink-faint)" }}>+{eventos.length - 2} más</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModuloDashboard() {
  const { creditos, historicoIBR, buscarGlobal, irACreditoDetalle, irAFlujoMes } = useApp();
  const [filtroBanco, setFiltroBanco] = useState("todos");
  const [filtroCredito, setFiltroCredito] = useState("todos");
  const [filtroAnio, setFiltroAnio] = useState("todos");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [periodo, setPeriodo] = useState("12");
  const [mesCalendario, setMesCalendario] = useState(mesActualISO());
  const [diaSeleccionado, setDiaSeleccionado] = useState(null);
  const [buscarPagos, setBuscarPagos] = useState("");

  const bancos = useMemo(() => Array.from(new Set(creditos.map((c) => c.banco))), [creditos]);
  const anios = useMemo(() => Array.from(new Set(creditos.map((c) => anioDe(c.fechaVencimiento)))).sort(), [creditos]);

  const creditosFiltrados = useMemo(() => creditos.filter((c) =>
    (filtroBanco === "todos" || c.banco === filtroBanco) &&
    (filtroCredito === "todos" || c.id === filtroCredito) &&
    (filtroAnio === "todos" || anioDe(c.fechaVencimiento) === Number(filtroAnio)) &&
    (filtroEstado === "todos" || c.estado === filtroEstado)
  ), [creditos, filtroBanco, filtroCredito, filtroAnio, filtroEstado]);

  // Se recalcula automáticamente cada vez que cambian los créditos o el
  // histórico de IBR (dependencias del hook), sin intervención manual.
  const { cargando, valor: datos } = useCalculoConCarga(
    () => calcularDatosDashboard(creditosFiltrados, historicoIBR),
    [creditosFiltrados, historicoIBR]
  );

  const obligacionAId = useMemo(() => new Map(creditos.map((c) => [c.numeroObligacion, c.id])), [creditos]);
  const abrirCreditoPorObligacion = (numeroObligacion) => {
    const id = obligacionAId.get(numeroObligacion);
    if (id) irACreditoDetalle(id);
  };

  if (cargando || !datos) {
    return (<><TopBar titulo="Dashboard" subtitulo="Panel ejecutivo de la deuda financiera" /><Card style={{ margin: 32 }}><Spinner etiqueta="Calculando indicadores…" /></Card></>);
  }

  const nMeses = periodo === "todo" ? datos.flujoProyectado.length : Number(periodo);
  const flujoRecortado = datos.flujoProyectado.slice(0, nMeses);
  const evolucionRecortada = periodo === "todo" ? datos.evolucionSaldo : datos.evolucionSaldo.slice(0, nMeses + 1);

  const tarjetas = [
    { label: "Saldo total de la deuda", valor: formatCOP(datos.saldoTotal), icono: Wallet, onClick: () => buscarGlobal("") },
    { label: "Créditos activos", valor: datos.numActivos, icono: Landmark, onClick: () => buscarGlobal("") },
    { label: "Próximo pago", valor: datos.proximoPago ? formatFecha(datos.proximoPago.fecha) : "—", sub: datos.proximoPago ? formatCOP(datos.proximoPago.pagoTotal) : null, icono: CalendarClock, onClick: datos.proximoPago ? () => irAFlujoMes(mesDe(datos.proximoPago.fecha)) : undefined },
    { label: "Intereses por pagar este mes", valor: formatCOP(datos.interesesMes), icono: TrendingUp, onClick: () => irAFlujoMes(mesActualISO()) },
    { label: "Capital por pagar este mes", valor: formatCOP(datos.capitalMes), icono: Calculator, onClick: () => irAFlujoMes(mesActualISO()) },
    { label: "Pago total del mes", valor: formatCOP(datos.pagoTotalMes), icono: Wallet, onClick: () => irAFlujoMes(mesActualISO()) },
    { label: "Tasa promedio ponderada", valor: formatPct(datos.tasaPromedioPonderada), icono: TrendingUp },
    { label: "Créditos en período de gracia", valor: datos.numGracia, icono: Clock, onClick: () => setFiltroEstado("En gracia") },
  ];

  const pagosFiltrados = datos.flujoFuturo
    .filter((f) => `${f.banco} ${f.numeroObligacion}`.toLowerCase().includes(buscarPagos.toLowerCase()))
    .slice(0, 30);

  const textoFiltrosDashboard = [
    filtroBanco !== "todos" && `Banco: ${filtroBanco}`,
    filtroCredito !== "todos" && `Crédito: ${creditos.find((c) => c.id === filtroCredito)?.numeroObligacion}`,
    filtroAnio !== "todos" && `Año: ${filtroAnio}`,
    filtroEstado !== "todos" && `Estado: ${filtroEstado}`,
    `Período de proyección: ${periodo === "todo" ? "Todo el plazo" : `Próximos ${periodo} meses`}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <TopBar
        titulo="Dashboard" subtitulo="Panel ejecutivo — Gerencia Financiera, Tesorería y Dirección Administrativa"
        acciones={<Boton variant="ghost" onClick={() => exportarDashboardExcel(datos, textoFiltrosDashboard)}><Download size={15} /> Exportar informe ejecutivo</Boton>}
      />
      <div style={{ padding: 32 }}>
        {/* Filtros globales */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          <select style={{ ...inputStyle, width: 150 }} value={filtroBanco} onChange={(e) => setFiltroBanco(e.target.value)} aria-label="Filtrar por banco"><option value="todos">Todos los bancos</option>{bancos.map((b) => <option key={b} value={b}>{b}</option>)}</select>
          <select style={{ ...inputStyle, width: 200 }} value={filtroCredito} onChange={(e) => setFiltroCredito(e.target.value)} aria-label="Filtrar por crédito"><option value="todos">Todos los créditos</option>{creditos.map((c) => <option key={c.id} value={c.id}>{c.banco} — {c.numeroObligacion}</option>)}</select>
          <select style={{ ...inputStyle, width: 120 }} value={filtroAnio} onChange={(e) => setFiltroAnio(e.target.value)} aria-label="Filtrar por año"><option value="todos">Todos los años</option>{anios.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          <select style={{ ...inputStyle, width: 150 }} value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)} aria-label="Filtrar por estado"><option value="todos">Todos los estados</option>{ESTADOS_CREDITO.map((e) => <option key={e} value={e}>{e}</option>)}</select>
          <select style={{ ...inputStyle, width: 170 }} value={periodo} onChange={(e) => setPeriodo(e.target.value)} aria-label="Período de proyección"><option value="12">Próximos 12 meses</option><option value="24">Próximos 24 meses</option><option value="todo">Todo el plazo</option></select>
        </div>

        {/* Tarjetas principales */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 24 }}>
          {tarjetas.map((t) => <TarjetaDashboard key={t.label} {...t} />)}
        </div>

        {/* Indicadores clave */}
        <Card style={{ marginBottom: 24 }}>
          <strong style={{ fontSize: 13, display: "block", marginBottom: 12 }}>Indicadores clave</strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 16 }}>
            <IndicadorMini label="Capital pendiente" valor={formatCOP(datos.saldoTotal)} />
            <IndicadorMini label="Intereses futuros proyectados" valor={formatCOP(datos.interesesFuturosProyectados)} />
            <IndicadorMini label="Pago promedio mensual" valor={formatCOP(datos.pagoPromedioMensual)} />
            <IndicadorMini label="Vida promedio de la deuda" valor={`${Math.floor(datos.vidaPromedioMeses / 12)} años, ${Math.round(datos.vidaPromedioMeses % 12)} meses`} />
            <IndicadorMini label="Tasa promedio ponderada" valor={formatPct(datos.tasaPromedioPonderada)} />
          </div>
        </Card>

        {/* Panel de alertas */}
        <Card style={{ marginBottom: 24, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={15} color="var(--amber)" /> Alertas ({datos.alertas.length})
          </div>
          <div className="sdf-scrollbar" style={{ maxHeight: 220, overflowY: "auto" }}>
            {datos.alertas.slice(0, 20).map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 18px", borderBottom: "1px solid var(--line-soft)", fontSize: 12.5 }}>
                <BadgePrioridad prioridad={a.prioridad} />
                <span style={{ flex: 1 }}>{a.texto}</span>
              </div>
            ))}
            {datos.alertas.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--ink-faint)", fontSize: 13 }}>Sin alertas activas.</div>}
          </div>
        </Card>

        {/* Gráficos */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <Card>
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Deuda por banco</strong>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={datos.deudaPorBanco} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="banco" tick={{ fontSize: 10.5 }} />
                <YAxis tickFormatter={(v) => new Intl.NumberFormat("es-CO", { notation: "compact" }).format(v)} tick={{ fontSize: 10 }} width={54} />
                <GraficoTooltip content={<TooltipGrafico formateador={(v, n) => n === "saldo" ? formatCOP(v) : `${formatNumero(v, 1)}%`} />} />
                <Bar dataKey="saldo" name="Saldo" fill="var(--teal)" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d) => buscarGlobal(d.banco)} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Deuda por año de vencimiento</strong>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={datos.deudaPorAnio} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="anio" tick={{ fontSize: 10.5 }} />
                <YAxis tickFormatter={(v) => new Intl.NumberFormat("es-CO", { notation: "compact" }).format(v)} tick={{ fontSize: 10 }} width={54} />
                <GraficoTooltip content={<TooltipGrafico formateador={(v) => formatCOP(v)} />} />
                <Bar dataKey="saldo" name="Saldo" fill="var(--navy-700)" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d) => setFiltroAnio(d.anio)} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>

        <Card style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Flujo de caja proyectado</strong>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={flujoRecortado} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="mes" tickFormatter={(m) => nombreMes(m).slice(0, 3) + " " + m.slice(2, 4)} tick={{ fontSize: 10.5 }} />
              <YAxis tickFormatter={(v) => new Intl.NumberFormat("es-CO", { notation: "compact" }).format(v)} tick={{ fontSize: 10 }} width={54} />
              <GraficoTooltip content={<TooltipGrafico formateador={(v) => formatCOP(v)} />} labelFormatter={nombreMes} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="capital" name="Capital" stroke="var(--navy-700)" strokeWidth={2} dot={{ r: 2, cursor: "pointer", onClick: (e, i) => irAFlujoMes(flujoRecortado[i.index]?.mes) }} />
              <Line type="monotone" dataKey="intereses" name="Intereses" stroke="var(--amber)" strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="total" name="Total" stroke="var(--teal)" strokeWidth={2.5} dot={{ r: 3, cursor: "pointer" }} activeDot={{ r: 5, onClick: (_, p) => irAFlujoMes(p.payload.mes) }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginBottom: 16 }}>
          <Card>
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Evolución del saldo de la deuda</strong>
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={evolucionRecortada} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="mes" tickFormatter={(m) => nombreMes(m).slice(0, 3) + " " + m.slice(2, 4)} tick={{ fontSize: 10.5 }} />
                <YAxis tickFormatter={(v) => new Intl.NumberFormat("es-CO", { notation: "compact" }).format(v)} tick={{ fontSize: 10 }} width={54} />
                <GraficoTooltip content={<TooltipGrafico formateador={(v) => formatCOP(v)} />} labelFormatter={nombreMes} />
                <Line type="monotone" dataKey="saldo" name="Saldo" stroke="var(--teal)" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Distribución de la deuda</strong>
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={datos.deudaPorBanco} dataKey="saldo" nameKey="banco" innerRadius={55} outerRadius={85} paddingAngle={2} cursor="pointer" onClick={(d) => buscarGlobal(d.banco)}>
                  {datos.deudaPorBanco.map((d, i) => <Cell key={d.banco} fill={COLORES_DONA[i % COLORES_DONA.length]} />)}
                </Pie>
                <GraficoTooltip content={<TooltipGrafico formateador={(v, n) => n === "saldo" ? formatCOP(v) : v} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* Calendario de pagos */}
        <Card style={{ marginBottom: 16 }}>
          <strong style={{ fontSize: 13.5, display: "block", marginBottom: 14 }}>Calendario de pagos</strong>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20 }}>
            <CalendarioPagos mesISO={mesCalendario} onCambiarMes={setMesCalendario} calendarioMapa={datos.calendarioMapa} diaSeleccionado={diaSeleccionado} onSeleccionarDia={(fecha) => setDiaSeleccionado(fecha)} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 8 }}>
                {diaSeleccionado ? `Pagos del ${formatFecha(diaSeleccionado)}` : "Selecciona un día con pagos"}
              </div>
              {diaSeleccionado && (datos.calendarioMapa.get(diaSeleccionado) || []).map((e, i) => (
                <button key={i} onClick={() => abrirCreditoPorObligacion(e.numeroObligacion)} className="sdf-focus" style={{ width: "100%", textAlign: "left", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 11px", marginBottom: 8, cursor: "pointer" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{e.banco} — {e.numeroObligacion}</div>
                  <div className="sdf-num" style={{ fontSize: 11.5, color: "var(--ink-soft)", marginTop: 2 }}>Capital {formatCOP(e.pagoCapital)} · Intereses {formatCOP(e.pagoIntereses)} · Total {formatCOP(e.pagoTotal)}</div>
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/* Tablas ejecutivas */}
        <Card style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <strong style={{ fontSize: 14 }}>Próximos pagos</strong>
            <input style={{ ...inputStyle, width: 220 }} placeholder="Buscar banco u obligación…" value={buscarPagos} onChange={(e) => setBuscarPagos(e.target.value)} aria-label="Buscar en próximos pagos" />
          </div>
          <div className="sdf-scrollbar" style={{ maxHeight: 320, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "var(--paper)" }}><th style={thStyle}>Fecha</th><th style={thStyle}>Banco</th><th style={thStyle}>Obligación</th><th style={{ ...thStyle, textAlign: "right" }}>Capital</th><th style={{ ...thStyle, textAlign: "right" }}>Intereses</th><th style={{ ...thStyle, textAlign: "right" }}>Total</th></tr></thead>
              <tbody>
                {pagosFiltrados.map((f, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }} onClick={() => abrirCreditoPorObligacion(f.numeroObligacion)}>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{formatFecha(f.fecha)}</td>
                    <td style={{ padding: "9px 14px" }}>{f.banco}</td>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{f.numeroObligacion}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.pagoCapital)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right" }} className="sdf-num">{formatCOP(f.pagoIntereses)}</td>
                    <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600 }} className="sdf-num">{formatCOP(f.pagoTotal)}</td>
                  </tr>
                ))}
                {pagosFiltrados.length === 0 && <tr><td colSpan={6} style={{ padding: 26, textAlign: "center", color: "var(--ink-faint)" }}>No hay pagos que coincidan.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 600, fontSize: 14 }}>Créditos próximos a vencer (12 meses)</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "var(--paper)" }}><th style={thStyle}>Banco</th><th style={thStyle}>Obligación</th><th style={thStyle}>Vencimiento</th></tr></thead>
              <tbody>
                {datos.proximosAVencer.map((c) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }} onClick={() => irACreditoDetalle(c.id)}>
                    <td style={{ padding: "9px 14px" }}>{c.banco}</td>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{c.numeroObligacion}</td>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{formatFecha(c.fechaVencimiento)}</td>
                  </tr>
                ))}
                {datos.proximosAVencer.length === 0 && <tr><td colSpan={3} style={{ padding: 22, textAlign: "center", color: "var(--ink-faint)" }}>Ninguno.</td></tr>}
              </tbody>
            </table>
          </Card>

          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 600, fontSize: 14 }}>Créditos con período de gracia</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "var(--paper)" }}><th style={thStyle}>Banco</th><th style={thStyle}>Obligación</th><th style={thStyle}>Fin de gracia</th><th style={thStyle}>1ª amortización</th></tr></thead>
              <tbody>
                {datos.conGracia.map(({ credito, finGracia, primeraAmortizacion }) => (
                  <tr key={credito.id} style={{ borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }} onClick={() => irACreditoDetalle(credito.id)}>
                    <td style={{ padding: "9px 14px" }}>{credito.banco}</td>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{credito.numeroObligacion}</td>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{formatFecha(finGracia)}</td>
                    <td style={{ padding: "9px 14px" }} className="sdf-num">{primeraAmortizacion ? formatFecha(primeraAmortizacion) : "—"}</td>
                  </tr>
                ))}
                {datos.conGracia.length === 0 && <tr><td colSpan={4} style={{ padding: 22, textAlign: "center", color: "var(--ink-faint)" }}>Ninguno.</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}

function IndicadorMini({ label, valor }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginBottom: 3 }}>{label}</div>
      <div className="sdf-num" style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>{valor}</div>
    </div>
  );
}

/* ---- 5.8 Módulo: Configuración ------------------------------------------ */
const PESTANAS_CONFIG = [
  { key: "general", label: "General" },
  { key: "bancos", label: "Bancos" },
  { key: "auditoria", label: "Auditoría" },
  { key: "respaldo", label: "Respaldo" },
];

function FilaBanco({ banco, enUso, onEditar, onAlternar, onEliminar }) {
  const [editando, setEditando] = useState(false);
  const [nombre, setNombre] = useState(banco.nombre);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
      {editando ? (
        <input style={{ ...inputStyle, flex: 1 }} value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus />
      ) : (
        <span style={{ flex: 1, fontSize: 13, color: banco.activo ? "var(--ink)" : "var(--ink-faint)", textDecoration: banco.activo ? "none" : "line-through" }}>{banco.nombre}</span>
      )}
      {!banco.activo && <span style={{ fontSize: 10.5, color: "var(--ink-faint)", background: "var(--line-soft)", padding: "2px 7px", borderRadius: 10 }}>Inactivo</span>}
      {editando ? (
        <>
          <button onClick={() => { onEditar(nombre); setEditando(false); }} style={iconBtnStyle} aria-label="Guardar nombre"><Check size={13} /></button>
          <button onClick={() => { setNombre(banco.nombre); setEditando(false); }} style={iconBtnStyle} aria-label="Cancelar edición"><X size={13} /></button>
        </>
      ) : (
        <>
          <button onClick={() => setEditando(true)} style={iconBtnStyle} title="Editar" aria-label={`Editar ${banco.nombre}`}><Pencil size={13} /></button>
          <button onClick={onAlternar} style={iconBtnStyle} title={banco.activo ? "Desactivar" : "Activar"} aria-label={`${banco.activo ? "Desactivar" : "Activar"} ${banco.nombre}`}><CircleDot size={13} /></button>
          <button
            onClick={onEliminar}
            style={{ ...iconBtnStyle, color: enUso ? "var(--ink-faint)" : "var(--rose)", cursor: enUso ? "not-allowed" : "pointer" }}
            title={enUso ? "No se puede eliminar: tiene créditos asociados" : "Eliminar"}
            aria-label={`Eliminar ${banco.nombre}`}
            disabled={enUso}
          >
            <Trash2 size={13} />
          </button>
        </>
      )}
    </div>
  );
}

function AsistenteRestaurar({ onCerrar }) {
  const { restaurarDesdeRespaldo } = useApp();
  const [paso, setPaso] = useState("subir");
  const [validacion, setValidacion] = useState(null);
  const [datos, setDatos] = useState(null);
  const [errorLectura, setErrorLectura] = useState(null);

  const leerArchivo = async (file) => {
    setErrorLectura(null);
    try {
      const texto = await file.text();
      const json = JSON.parse(texto);
      const v = validarRespaldo(json);
      setDatos(json);
      setValidacion(v);
      setPaso("resumen");
    } catch (e) {
      setErrorLectura("No se pudo leer el archivo. Verifique que sea un respaldo JSON generado por este sistema.");
    }
  };

  const confirmar = () => {
    restaurarDesdeRespaldo(datos);
    onCerrar();
  };

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(14,26,43,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 16 }}>
      <Card style={{ width: 520, maxWidth: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, margin: 0 }}>Restaurar desde respaldo</h2>
          <button onClick={onCerrar} aria-label="Cerrar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)" }}><X size={20} /></button>
        </div>

        {paso === "subir" && (
          <div>
            <div style={{ display: "flex", gap: 8, background: "var(--amber-soft)", color: "var(--amber)", padding: "9px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 14 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> Esto reemplazará todos los créditos, tasas IBR y configuración actuales. Se validará el archivo antes de aplicar cualquier cambio.
            </div>
            {errorLectura && <div style={{ display: "flex", gap: 8, background: "var(--rose-soft)", color: "var(--rose)", padding: "9px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}><AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />{errorLectura}</div>}
            <input type="file" accept=".json" onChange={(e) => e.target.files[0] && leerArchivo(e.target.files[0])} aria-label="Seleccionar archivo de respaldo" style={{ fontSize: 13 }} />
          </div>
        )}

        {paso === "resumen" && validacion && (
          <div>
            {validacion.valido ? (
              <>
                <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                  <ResumenPill bg="var(--teal-soft)" color="var(--teal-strong)" label="Créditos" valor={datos.creditos.length} />
                  <ResumenPill bg="var(--teal-soft)" color="var(--teal-strong)" label="Tasas IBR" valor={datos.historicoIBR.length} />
                </div>
                {datos.generadoEl && <p style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 14 }}>Respaldo generado el {formatFecha(datos.generadoEl.slice(0, 10))}.</p>}
                <div style={{ display: "flex", gap: 8 }}>
                  <Boton onClick={confirmar}><Check size={14} /> Confirmar restauración</Boton>
                  <Boton variant="ghost" onClick={onCerrar}>Cancelar</Boton>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--rose)", fontWeight: 600, marginBottom: 8 }}>El archivo no pasó la validación de integridad:</div>
                <ul style={{ fontSize: 12.5, color: "var(--ink-soft)", paddingLeft: 18, marginBottom: 14 }}>
                  {validacion.errores.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
                <Boton variant="ghost" onClick={() => setPaso("subir")}>Elegir otro archivo</Boton>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function ModuloConfiguracion() {
  const { limpiarEjemplo, creditos, historicoIBR, configuracion, auditoria, crearBanco, editarBanco, alternarActivoBanco, eliminarBanco, establecerDecimales } = useApp();
  const [pestana, setPestana] = useState("general");
  const [nuevoBanco, setNuevoBanco] = useState("");
  const [restaurando, setRestaurando] = useState(false);
  const [busquedaAuditoria, setBusquedaAuditoria] = useState("");

  const bancosEnUso = useMemo(() => new Set(creditos.map((c) => c.banco)), [creditos]);
  const auditoriaFiltrada = auditoria.filter((a) => `${a.accion} ${a.descripcion}`.toLowerCase().includes(busquedaAuditoria.toLowerCase()));

  return (
    <>
      <TopBar titulo="Configuración" subtitulo="Catálogos, parámetros, auditoría y respaldo del sistema" />
      <div style={{ padding: 32 }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--line)" }}>
          {PESTANAS_CONFIG.map((p) => (
            <button
              key={p.key}
              onClick={() => setPestana(p.key)}
              className="sdf-focus"
              style={{
                padding: "9px 16px", background: "none", border: "none", cursor: "pointer", fontSize: 13,
                fontWeight: pestana === p.key ? 700 : 500, color: pestana === p.key ? "var(--teal-strong)" : "var(--ink-soft)",
                borderBottom: pestana === p.key ? "2px solid var(--teal)" : "2px solid transparent", marginBottom: -1,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {pestana === "general" && (
          <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
            <Card>
              <strong style={{ fontSize: 14, display: "block", marginBottom: 10 }}>Parámetros financieros</strong>
              <FilaResumen label="Moneda" valor="COP — Peso colombiano" />
              <FilaResumen label="Base de cálculo" valor="30/360 (fija, no editable)" />
              <FilaResumen label="Tipo de tasa" valor="IBR + Spread fijo" />
              <FilaResumen label="Formato de fecha" valor="DD/MM/AAAA" />
              <FilaResumen label="Desembolsos" valor="Único por crédito" />
              <FilaResumen label="Pagos anticipados" valor="No disponibles en esta versión" />
            </Card>
            <Card>
              <strong style={{ fontSize: 14, display: "block", marginBottom: 10 }}>Formato monetario</strong>
              <Campo label="Decimales al mostrar valores en COP" hint="Afecta cómo se muestran los montos en toda la aplicación (no cambia ningún cálculo).">
                <select style={{ ...inputStyle, width: 160 }} value={configuracion.decimales} onChange={(e) => establecerDecimales(Number(e.target.value))}>
                  <option value={0}>Sin decimales — $1.200.000</option>
                  <option value={2}>Dos decimales — $1.200.000,00</option>
                </select>
              </Campo>
            </Card>
            <Card>
              <strong style={{ fontSize: 14, display: "block", marginBottom: 10 }}>Tipos de amortización</strong>
              <FilaResumen label="Capital constante" valor="Implementado" />
              <FilaResumen label="Capital constante con gracia" valor="Implementado" />
              <FilaResumen label="Bullet / Cuota fija / Personalizada" valor="Arquitectura preparada, no implementados" />
            </Card>
            <Card>
              <strong style={{ fontSize: 14, display: "block", marginBottom: 6 }}>Plantillas de importación</strong>
              <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 12px" }}>
                Descargue las plantillas vacías con encabezados, un ejemplo e instrucciones.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Boton variant="ghost" onClick={descargarPlantillaCreditos}><Download size={14} /> Plantilla de créditos</Boton>
                <Boton variant="ghost" onClick={descargarPlantillaIBR}><Download size={14} /> Plantilla de IBR</Boton>
              </div>
            </Card>
            <Card>
              <strong style={{ fontSize: 14, display: "block", marginBottom: 10 }}>Datos de ejemplo</strong>
              <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 12px" }}>
                Este sistema tiene {creditos.length} crédito(s) y {historicoIBR.length} tasa(s) IBR guardados. Toda la información se guarda automáticamente y persiste al cerrar el navegador.
              </p>
              <Boton variant="danger" onClick={limpiarEjemplo}><Trash2 size={14} /> Borrar todos los datos</Boton>
            </Card>
          </div>
        )}

        {pestana === "bancos" && (
          <Card style={{ maxWidth: 480 }}>
            <strong style={{ fontSize: 14, display: "block", marginBottom: 4 }}>Catálogo de bancos</strong>
            <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 12px" }}>Los bancos desactivados dejan de aparecer al crear créditos nuevos, pero siguen visibles en los créditos que ya los usan.</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="Nombre del nuevo banco" value={nuevoBanco} onChange={(e) => setNuevoBanco(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && nuevoBanco.trim()) { crearBanco(nuevoBanco); setNuevoBanco(""); } }} />
              <Boton onClick={() => { if (nuevoBanco.trim()) { crearBanco(nuevoBanco); setNuevoBanco(""); } }}><Plus size={14} /> Agregar</Boton>
            </div>
            <div>
              {configuracion.bancos.map((b) => (
                <FilaBanco
                  key={b.id}
                  banco={b}
                  enUso={bancosEnUso.has(b.nombre)}
                  onEditar={(nombre) => editarBanco(b.id, nombre)}
                  onAlternar={() => alternarActivoBanco(b.id)}
                  onEliminar={() => eliminarBanco(b.id)}
                />
              ))}
            </div>
          </Card>
        )}

        {pestana === "auditoria" && (
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
              <strong style={{ fontSize: 14 }}>Registro de auditoría ({auditoria.length})</strong>
              <input style={{ ...inputStyle, width: 220 }} placeholder="Buscar en auditoría…" value={busquedaAuditoria} onChange={(e) => setBusquedaAuditoria(e.target.value)} aria-label="Buscar en auditoría" />
            </div>
            <div className="sdf-scrollbar" style={{ maxHeight: 460, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ background: "var(--paper)" }}><th style={thStyle}>Fecha y hora</th><th style={thStyle}>Acción</th><th style={thStyle}>Descripción</th><th style={thStyle}>Usuario</th></tr></thead>
                <tbody>
                  {auditoriaFiltrada.slice(0, 200).map((a) => (
                    <tr key={a.id} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                      <td style={{ padding: "8px 14px" }} className="sdf-num">{new Date(a.fechaHora).toLocaleString("es-CO")}</td>
                      <td style={{ padding: "8px 14px", fontWeight: 600 }}>{a.accion}</td>
                      <td style={{ padding: "8px 14px", color: "var(--ink-soft)" }}>{a.descripcion}</td>
                      <td style={{ padding: "8px 14px", color: "var(--ink-faint)" }}>{a.usuario}</td>
                    </tr>
                  ))}
                  {auditoriaFiltrada.length === 0 && <tr><td colSpan={4} style={{ padding: 26, textAlign: "center", color: "var(--ink-faint)" }}>Sin registros todavía.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {pestana === "respaldo" && (
          <Card style={{ maxWidth: 520 }}>
            <strong style={{ fontSize: 14, display: "block", marginBottom: 6 }}>Respaldo y recuperación</strong>
            <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 14px" }}>
              El respaldo incluye créditos, histórico de IBR, configuración y auditoría en un archivo JSON que conserva toda la precisión de la información.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Boton onClick={() => descargarRespaldoCompleto(creditos, historicoIBR, configuracion, auditoria)}><Download size={14} /> Descargar respaldo completo</Boton>
              <Boton variant="ghost" onClick={() => setRestaurando(true)}><Upload size={14} /> Restaurar desde respaldo</Boton>
            </div>
          </Card>
        )}
      </div>

      {restaurando && <AsistenteRestaurar onCerrar={() => setRestaurando(false)} />}
    </>
  );
}

/* ----------------------------------------------------------------------------
   6. IMPORTACIÓN Y EXPORTACIÓN A EXCEL
   ----------------------------------------------------------------------------
   6.1 Utilidades de construcción de libros/hojas (formato profesional)
   6.2 Exportación por módulo (Créditos, Cronograma, Causación, Flujo, Dashboard)
   6.3 Plantillas descargables (Créditos, IBR)
   6.4 Lectura y validación de archivos importados
   6.5 Asistente de importación (UI, con barra de progreso y resumen)

   Todo lo exportado proviene de lo que el motor y los módulos ya calcularon
   (cronograma, causación, flujo, saldos, resúmenes) — esta sección solo
   traduce esos datos a formato Excel, sin recalcular nada financiero. La
   validación de una fila importada de crédito reutiliza
   MotorFinanciero.validarCredito en vez de reinventar sus reglas.
   -------------------------------------------------------------------------- */

/* 6.1 — Utilidades de construcción de libros */
function fechaHoraArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function fechaHoraLegible() {
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "long", timeStyle: "short" }).format(new Date());
}

// Construye una hoja con bloque de título (título + fecha/hora de generación
// + filtros aplicados), encabezados y datos, con anchos de columna y formato
// numérico por columna (moneda/porcentaje/fecha/número), preservando el
// valor numérico real — el formato solo cambia cómo se ve en Excel.
function construirHoja(titulo, filtrosTexto, columnas, filas, filaTotales) {
  const aoa = [];
  aoa.push([titulo]);
  aoa.push([`Generado el ${fechaHoraLegible()}`]);
  aoa.push([`Filtros aplicados: ${filtrosTexto || "Ninguno"}`]);
  aoa.push([]);
  const filaEncabezado = aoa.length;
  aoa.push(columnas.map((c) => c.header));

  const convertirValor = (c, v) => {
    if (c.formato === "fecha" && v) return new Date(`${v}T00:00:00`);
    return v === undefined ? "" : v;
  };
  filas.forEach((fila) => aoa.push(columnas.map((c) => convertirValor(c, fila[c.key]))));
  if (filaTotales) aoa.push(columnas.map((c) => convertirValor(c, filaTotales[c.key])));

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  ws["!cols"] = columnas.map((c) => ({ wch: c.ancho || 16 }));
  const primerFilaDatos = filaEncabezado + 1;
  const ultimaFilaDatos = aoa.length - 1;
  const FORMATOS = { moneda: "#,##0", porcentaje: '0.00"%"', fecha: "dd/mm/yyyy", numero: "#,##0.00" };
  columnas.forEach((c, colIdx) => {
    if (!c.formato || c.formato === "texto" || !FORMATOS[c.formato]) return;
    for (let r = primerFilaDatos; r <= ultimaFilaDatos; r++) {
      const ref = XLSX.utils.encode_cell({ r, c: colIdx });
      if (ws[ref] && ws[ref].v !== "") ws[ref].z = FORMATOS[c.formato];
    }
  });
  // Congelar encabezados (mejor esfuerzo: algunas versiones de Excel/visores lo respetan, otras lo ignoran sin error)
  ws["!freeze"] = { xSplit: 0, ySplit: filaEncabezado + 1 };
  return ws;
}

function descargarLibro(hojas, nombreBase) {
  const wb = XLSX.utils.book_new();
  hojas.forEach(({ nombre, ws }) => XLSX.utils.book_append_sheet(wb, ws, nombre.slice(0, 31)));
  XLSX.writeFile(wb, `${nombreBase}_${fechaHoraArchivo()}.xlsx`);
}

/* 6.2 — Exportación por módulo */
function exportarCreditosExcel(creditosFiltrados, historicoIBR, filtrosTexto) {
  const columnas = [
    { header: "Banco", key: "banco", ancho: 18 },
    { header: "Número de obligación", key: "numeroObligacion", ancho: 20 },
    { header: "Descripción", key: "descripcion", ancho: 30 },
    { header: "Valor desembolsado", key: "valorDesembolsado", ancho: 18, formato: "moneda" },
    { header: "Fecha desembolso", key: "fechaDesembolso", ancho: 14, formato: "fecha" },
    { header: "Fecha vencimiento", key: "fechaVencimiento", ancho: 14, formato: "fecha" },
    { header: "Plazo (meses)", key: "plazoMeses", ancho: 12, formato: "numero" },
    { header: "Spread (%)", key: "spread", ancho: 10, formato: "porcentaje" },
    { header: "Periodicidad intereses", key: "periodicidadIntereses", ancho: 18 },
    { header: "Periodicidad capital", key: "periodicidadCapital", ancho: 18 },
    { header: "Meses de gracia", key: "mesesGracia", ancho: 12, formato: "numero" },
    { header: "Estado", key: "estado", ancho: 14 },
    { header: "Saldo actual", key: "saldoActual", ancho: 18, formato: "moneda" },
    { header: "Próximo pago (fecha)", key: "proximoPagoFecha", ancho: 16, formato: "fecha" },
    { header: "Próximo pago (valor)", key: "proximoPagoValor", ancho: 18, formato: "moneda" },
    { header: "Observaciones", key: "observaciones", ancho: 32 },
  ];
  const filas = creditosFiltrados.map((c) => {
    const r = obtenerResumenCredito(c, historicoIBR);
    return { ...c, saldoActual: r.saldoActual ?? c.valorDesembolsado, proximoPagoFecha: r.proximoPago?.fecha, proximoPagoValor: r.proximoPago?.pagoTotal };
  });
  const ws = construirHoja("Créditos — Sistema de Deuda Financiera", filtrosTexto, columnas, filas);
  descargarLibro([{ nombre: "Créditos", ws }], "Creditos");
}

const COLUMNAS_CRONOGRAMA_EXPORT = [
  { header: "Fecha", key: "fecha", ancho: 12, formato: "fecha" },
  { header: "Banco", key: "banco", ancho: 16 },
  { header: "Obligación", key: "numeroObligacion", ancho: 18 },
  { header: "Tipo de evento", key: "tipoEventoTexto", ancho: 22 },
  { header: "Capital inicial", key: "capitalInicial", ancho: 16, formato: "moneda" },
  { header: "IBR", key: "ibrAplicada", ancho: 8, formato: "porcentaje" },
  { header: "Spread", key: "spread", ancho: 8, formato: "porcentaje" },
  { header: "Tasa total", key: "tasaTotal", ancho: 10, formato: "porcentaje" },
  { header: "Interés", key: "interes", ancho: 15, formato: "moneda" },
  { header: "Capital pagado", key: "capitalPagado", ancho: 15, formato: "moneda" },
  { header: "Pago total", key: "pagoTotal", ancho: 15, formato: "moneda" },
  { header: "Saldo final", key: "saldo", ancho: 16, formato: "moneda" },
];
function filasCronogramaParaExportar(filas) {
  return filas.map((f) => ({ ...f, banco: f.credito.banco, numeroObligacion: f.credito.numeroObligacion, tipoEventoTexto: etiquetaEvento(f.tipoEvento) }));
}
function exportarCronogramaExcel(filas, filtrosTexto) {
  const ws = construirHoja("Cronograma financiero", filtrosTexto, COLUMNAS_CRONOGRAMA_EXPORT, filasCronogramaParaExportar(filas));
  descargarLibro([{ nombre: "Cronograma", ws }], "Cronograma");
}

const COLUMNAS_CAUSACION_EXPORT = [
  { header: "Mes", key: "mesTexto", ancho: 16 },
  { header: "Banco", key: "banco", ancho: 16 },
  { header: "Obligación", key: "numeroObligacion", ancho: 18 },
  { header: "Días financieros", key: "diasFinancieros", ancho: 14, formato: "numero" },
  { header: "Interés causado", key: "interesCausado", ancho: 16, formato: "moneda" },
  { header: "Interés acumulado", key: "interesAcumulado", ancho: 16, formato: "moneda" },
  { header: "Interés pagado", key: "interesPagado", ancho: 16, formato: "moneda" },
  { header: "Saldo pendiente", key: "saldoPendienteCausar", ancho: 16, formato: "moneda" },
];
function exportarCausacionExcel(filas, filtrosTexto) {
  const filasExport = filas.map((f) => ({ ...f, mesTexto: nombreMes(f.mesContable), banco: f.credito.banco, numeroObligacion: f.credito.numeroObligacion }));
  const filaTotales = { mesTexto: "TOTAL", interesCausado: filas.reduce((s, f) => s + f.interesCausado, 0), interesPagado: filas.reduce((s, f) => s + f.interesPagado, 0) };
  const ws = construirHoja("Distribución contable (causación)", filtrosTexto, COLUMNAS_CAUSACION_EXPORT, filasExport, filaTotales);
  descargarLibro([{ nombre: "Causación", ws }], "Causacion");
}

const COLUMNAS_FLUJO_EXPORT = [
  { header: "Fecha", key: "fecha", ancho: 12, formato: "fecha" },
  { header: "Banco", key: "banco", ancho: 16 },
  { header: "Obligación", key: "numeroObligacion", ancho: 18 },
  { header: "Capital", key: "pagoCapital", ancho: 16, formato: "moneda" },
  { header: "Intereses", key: "pagoIntereses", ancho: 16, formato: "moneda" },
  { header: "Total", key: "pagoTotal", ancho: 16, formato: "moneda" },
];
function exportarFlujoExcel(filas, filtrosTexto) {
  const filaTotales = { banco: "TOTAL", pagoCapital: filas.reduce((s, f) => s + f.pagoCapital, 0), pagoIntereses: filas.reduce((s, f) => s + f.pagoIntereses, 0), pagoTotal: filas.reduce((s, f) => s + f.pagoTotal, 0) };
  const ws = construirHoja("Flujo de caja", filtrosTexto, COLUMNAS_FLUJO_EXPORT, filas, filaTotales);
  descargarLibro([{ nombre: "Flujo de Caja", ws }], "FlujoDeCaja");
}

function exportarIBRExcel(historicoIBR) {
  const columnas = [
    { header: "Fecha de vigencia", key: "fecha", ancho: 16, formato: "fecha" },
    { header: "Valor IBR E.A. (%)", key: "valorEA", ancho: 16, formato: "porcentaje" },
    { header: "Fuente", key: "fuente", ancho: 14 },
  ];
  const ws = construirHoja("Histórico de tasas IBR", "Ninguno", columnas, [...historicoIBR].sort((a, b) => a.fecha.localeCompare(b.fecha)));
  descargarLibro([{ nombre: "IBR", ws }], "Historico_IBR");
}

// Informe ejecutivo del Dashboard: 6 hojas, todas alimentadas por lo que
// calcularDatosDashboard ya agregó a partir del motor financiero.
function exportarDashboardExcel(datos, filtrosTexto) {
  const hojas = [];

  const colResumen = [{ header: "Indicador", key: "indicador", ancho: 34 }, { header: "Valor", key: "valor", ancho: 30 }];
  const filasResumen = [
    { indicador: "Saldo total de la deuda", valor: formatCOP(datos.saldoTotal) },
    { indicador: "Créditos activos", valor: datos.numActivos },
    { indicador: "Créditos en período de gracia", valor: datos.numGracia },
    { indicador: "Próximo pago", valor: datos.proximoPago ? `${formatFecha(datos.proximoPago.fecha)} — ${formatCOP(datos.proximoPago.pagoTotal)}` : "—" },
    { indicador: "Intereses por pagar este mes", valor: formatCOP(datos.interesesMes) },
    { indicador: "Capital por pagar este mes", valor: formatCOP(datos.capitalMes) },
    { indicador: "Pago total del mes", valor: formatCOP(datos.pagoTotalMes) },
    { indicador: "Tasa promedio ponderada", valor: formatPct(datos.tasaPromedioPonderada) },
  ];
  hojas.push({ nombre: "Resumen Ejecutivo", ws: construirHoja("Resumen Ejecutivo", filtrosTexto, colResumen, filasResumen) });

  const colIndicadores = [{ header: "Indicador", key: "indicador", ancho: 34 }, { header: "Valor", key: "valor", ancho: 20, formato: "numero" }, { header: "Unidad", key: "unidad", ancho: 12 }];
  const filasIndicadores = [
    { indicador: "Saldo total", valor: datos.saldoTotal, unidad: "COP" },
    { indicador: "Capital pendiente", valor: datos.saldoTotal, unidad: "COP" },
    { indicador: "Intereses futuros proyectados", valor: datos.interesesFuturosProyectados, unidad: "COP" },
    { indicador: "Pago promedio mensual", valor: datos.pagoPromedioMensual, unidad: "COP" },
    { indicador: "Vida promedio de la deuda", valor: Number(datos.vidaPromedioMeses.toFixed(1)), unidad: "meses" },
    { indicador: "Tasa promedio ponderada", valor: datos.tasaPromedioPonderada, unidad: "%" },
  ];
  hojas.push({ nombre: "Indicadores", ws: construirHoja("Indicadores", filtrosTexto, colIndicadores, filasIndicadores) });

  const colBanco = [{ header: "Banco", key: "banco", ancho: 20 }, { header: "Saldo", key: "saldo", ancho: 18, formato: "moneda" }, { header: "Participación (%)", key: "participacion", ancho: 16, formato: "porcentaje" }];
  hojas.push({ nombre: "Deuda por Banco", ws: construirHoja("Deuda por Banco", filtrosTexto, colBanco, datos.deudaPorBanco) });

  hojas.push({ nombre: "Próximos Pagos", ws: construirHoja("Próximos Pagos", filtrosTexto, COLUMNAS_FLUJO_EXPORT, datos.flujoFuturo) });

  const colFlujoMes = [{ header: "Mes", key: "mesTexto", ancho: 16 }, { header: "Capital", key: "capital", ancho: 18, formato: "moneda" }, { header: "Intereses", key: "intereses", ancho: 18, formato: "moneda" }, { header: "Total", key: "total", ancho: 18, formato: "moneda" }];
  hojas.push({ nombre: "Flujo de Caja", ws: construirHoja("Flujo de Caja Proyectado", filtrosTexto, colFlujoMes, datos.flujoProyectado.map((f) => ({ ...f, mesTexto: nombreMes(f.mes) }))) });

  const cronogramaConsolidado = datos.validos.flatMap((p) => p.cronograma.map((f) => ({ ...f, credito: p.credito }))).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  hojas.push({ nombre: "Cronograma Consolidado", ws: construirHoja("Cronograma Consolidado", filtrosTexto, COLUMNAS_CRONOGRAMA_EXPORT, filasCronogramaParaExportar(cronogramaConsolidado)) });

  descargarLibro(hojas, "Dashboard_Ejecutivo");
}

/* 6.3 — Plantillas descargables */
const INSTRUCCIONES_PLANTILLA_CREDITOS = [
  ["Instrucciones:"],
  ["- No cambie los encabezados de la fila 9."],
  ["- Fechas en formato DD/MM/AAAA."],
  ['- Tipo de amortización: "Capital constante" o "Capital constante con gracia".'],
  ['- Período de gracia (Sí/No): si es "Sí", indique los meses de gracia.'],
  ["- Periodicidad de intereses / capital: Mensual, Trimestral o Semestral."],
  ["- Estado: Activo, En gracia, Mora o Cancelado."],
  ["- Elimine la fila de ejemplo antes de importar sus propios datos."],
  [],
];
const ENCABEZADOS_PLANTILLA_CREDITOS = ["Banco", "Número de obligación", "Descripción", "Valor desembolsado", "Fecha de desembolso", "Fecha de vencimiento", "Plazo (meses)", "Spread (%)", "Tipo de amortización", "Periodicidad de intereses", "Periodicidad de capital", "Período de gracia (Sí/No)", "Meses de gracia", "Estado", "Observaciones"];
function descargarPlantillaCreditos() {
  const ejemplo = ["Bancolombia", "4500-112233", "Capital de trabajo cosecha 2026", 3200000000, "15/02/2026", "15/02/2031", 60, 3.25, "Capital constante", "Mensual", "Mensual", "No", 0, "Activo", "Garantía FNG 60%"];
  const aoa = [...INSTRUCCIONES_PLANTILLA_CREDITOS, ENCABEZADOS_PLANTILLA_CREDITOS, ejemplo];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [18, 20, 30, 18, 16, 16, 12, 10, 22, 18, 18, 16, 12, 14, 32].map((wch) => ({ wch }));
  descargarLibro([{ nombre: "Plantilla Créditos", ws }], "Plantilla_Creditos");
}

const INSTRUCCIONES_PLANTILLA_IBR = [
  ["Instrucciones:"],
  ["- No cambie los encabezados de la fila 5."],
  ["- Fecha de vigencia en formato DD/MM/AAAA (fecha desde la cual aplica la tasa)."],
  ["- Valor de la IBR en porcentaje, con punto o coma decimal (ej: 9.61)."],
  [],
];
const ENCABEZADOS_PLANTILLA_IBR = ["Fecha de vigencia", "Valor de la IBR (%)"];
function descargarPlantillaIBR() {
  const aoa = [...INSTRUCCIONES_PLANTILLA_IBR, ENCABEZADOS_PLANTILLA_IBR, ["01/06/2026", 9.55]];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [18, 18].map((wch) => ({ wch }));
  descargarLibro([{ nombre: "Plantilla IBR", ws }], "Plantilla_IBR");
}

/* 6.4 — Lectura y validación de archivos importados */
function leerFilasDesdeHoja(ws, primerEncabezadoEsperado) {
  const filasCrudas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  let idx = filasCrudas.findIndex((f) => String(f[0] || "").trim().toLowerCase() === primerEncabezadoEsperado.toLowerCase());
  if (idx === -1) idx = 0;
  const encabezados = filasCrudas[idx].map((h) => String(h || "").trim());
  const filas = [];
  for (let i = idx + 1; i < filasCrudas.length; i++) {
    const fila = filasCrudas[i];
    if (fila.every((v) => v === "" || v === undefined || v === null)) continue;
    const obj = {};
    encabezados.forEach((h, c) => { obj[h] = fila[c]; });
    filas.push(obj);
  }
  return filas;
}

function isoDesdeDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function normalizarFechaImportada(valor) {
  if (valor === "" || valor === null || valor === undefined) return null;
  if (valor instanceof Date) return isoDesdeDate(valor);
  const s = String(valor).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

const MAPA_ENCABEZADOS_CREDITO = {
  "Banco": "banco", "Número de obligación": "numeroObligacion", "Descripción": "descripcion",
  "Valor desembolsado": "valorDesembolsado", "Fecha de desembolso": "fechaDesembolsoCrudo",
  "Fecha de vencimiento": "fechaVencimientoCrudo", "Plazo (meses)": "plazoMeses", "Spread (%)": "spread",
  "Tipo de amortización": "tipoAmortizacionTexto", "Periodicidad de intereses": "periodicidadIntereses",
  "Periodicidad de capital": "periodicidadCapital", "Período de gracia (Sí/No)": "graciaTexto",
  "Meses de gracia": "mesesGracia", "Estado": "estado", "Observaciones": "observaciones",
};
const MAPA_ENCABEZADOS_IBR = { "Fecha de vigencia": "fechaCruda", "Valor de la IBR (%)": "valorEA" };

function validarFilaCredito(fila, contexto) {
  const errores = []; const advertencias = [];
  const banco = String(fila.banco || "").trim();
  if (!banco) errores.push("Banco es obligatorio.");
  const numeroObligacion = String(fila.numeroObligacion || "").trim();
  if (!numeroObligacion) errores.push("Número de obligación es obligatorio.");
  else if (contexto.numerosVistos.has(numeroObligacion)) errores.push("Número de obligación duplicado dentro del archivo.");
  else if (contexto.creditosExistentes.some((c) => c.numeroObligacion === numeroObligacion)) errores.push("Ya existe un crédito con ese número de obligación en el sistema.");
  if (numeroObligacion) contexto.numerosVistos.add(numeroObligacion);

  const valorDesembolsado = Number(fila.valorDesembolsado);
  if (fila.valorDesembolsado === "" || isNaN(valorDesembolsado) || valorDesembolsado <= 0) errores.push("Valor desembolsado debe ser un número mayor a 0.");

  const fechaDesembolso = normalizarFechaImportada(fila.fechaDesembolsoCrudo);
  if (!fechaDesembolso) errores.push("Fecha de desembolso inválida o vacía (use DD/MM/AAAA).");
  const fechaVencimiento = normalizarFechaImportada(fila.fechaVencimientoCrudo);
  if (!fechaVencimiento) errores.push("Fecha de vencimiento inválida o vacía (use DD/MM/AAAA).");
  else if (fechaDesembolso && fechaVencimiento <= fechaDesembolso) errores.push("La fecha de vencimiento debe ser posterior a la de desembolso.");

  const plazoMeses = Number(fila.plazoMeses);
  if (fila.plazoMeses === "" || isNaN(plazoMeses) || plazoMeses <= 0) errores.push("Plazo (meses) debe ser un número mayor a 0.");

  const spread = Number(fila.spread);
  if (fila.spread === "" || isNaN(spread) || spread < 0) errores.push("Spread (%) debe ser un número mayor o igual a 0.");

  const periodicidadIntereses = String(fila.periodicidadIntereses || "").trim();
  if (!MESES_POR_PERIODICIDAD[periodicidadIntereses]) errores.push('Periodicidad de intereses no reconocida (use "Mensual", "Trimestral" o "Semestral").');
  const periodicidadCapital = String(fila.periodicidadCapital || "").trim();
  if (!MESES_POR_PERIODICIDAD[periodicidadCapital]) errores.push('Periodicidad de capital no reconocida (use "Mensual", "Trimestral" o "Semestral").');

  const graciaTexto = String(fila.graciaTexto || "").trim().toLowerCase();
  const tieneGracia = graciaTexto === "sí" || graciaTexto === "si";
  const mesesGracia = Number(fila.mesesGracia) || 0;
  if (tieneGracia && mesesGracia <= 0) errores.push('Indique los meses de gracia cuando "Período de gracia" es Sí.');
  if (tieneGracia && plazoMeses && mesesGracia >= plazoMeses) errores.push("Los meses de gracia deben ser menores al plazo total.");

  let estado = String(fila.estado || "").trim();
  if (!ESTADOS_CREDITO.includes(estado)) { advertencias.push(`Estado "${estado || "(vacío)"}" no reconocido; se usará "Activo".`); estado = "Activo"; }

  const dato = {
    banco, numeroObligacion, descripcion: String(fila.descripcion || "").trim(),
    valorDesembolsado, fechaDesembolso, fechaVencimiento, plazoMeses, spread,
    tipoAmortizacion: tieneGracia ? "capital_constante_gracia" : "capital_constante",
    periodicidadIntereses, periodicidadCapital, mesesGracia, estado,
    observaciones: String(fila.observaciones || "").trim(),
  };

  if (errores.length === 0) {
    // Validación de dominio delegada al motor (no se reinventan sus reglas aquí)
    const chequeo = MotorFinanciero.validarCredito(dato, contexto.historicoIBR);
    if (!chequeo.valido) chequeo.errores.forEach((e) => (e.includes("IBR") ? advertencias.push(e) : errores.push(e)));
  }

  return { dato, errores, advertencias, valido: errores.length === 0 };
}

function validarFilaIBR(fila, contexto) {
  const errores = []; const advertencias = [];
  const fecha = normalizarFechaImportada(fila.fechaCruda);
  if (!fecha) errores.push("Fecha de vigencia inválida o vacía (use DD/MM/AAAA).");
  else if (contexto.fechasVistas.has(fecha)) errores.push("Fecha duplicada dentro del archivo.");
  if (fecha) contexto.fechasVistas.add(fecha);

  const valorEA = Number(fila.valorEA);
  if (fila.valorEA === "" || isNaN(valorEA) || valorEA < 0) errores.push("Valor de IBR debe ser un número mayor o igual a 0.");
  else if (valorEA > 50) advertencias.push(`Valor de IBR (${valorEA}%) parece fuera de rango habitual; verifique.`);

  if (fecha && contexto.historicoIBR.some((t) => t.fecha === fecha)) advertencias.push("Ya existe una tasa para esta fecha; se reemplazará su valor.");

  return { dato: { fecha, valorEA, fuente: "Importado" }, errores, advertencias, valido: errores.length === 0 };
}

const CONFIG_IMPORTACION = {
  creditos: {
    titulo: "Importar créditos", primerEncabezado: "Banco", mapaEncabezados: MAPA_ENCABEZADOS_CREDITO,
    validarFila: validarFilaCredito, descargarPlantilla: descargarPlantillaCreditos,
    construirContexto: (creditos, historicoIBR) => ({ numerosVistos: new Set(), creditosExistentes: creditos, historicoIBR }),
  },
  ibr: {
    titulo: "Importar histórico de IBR", primerEncabezado: "Fecha de vigencia", mapaEncabezados: MAPA_ENCABEZADOS_IBR,
    validarFila: validarFilaIBR, descargarPlantilla: descargarPlantillaIBR,
    construirContexto: (creditos, historicoIBR) => ({ fechasVistas: new Set(), historicoIBR }),
  },
};

/* 6.6 — Respaldo y recuperación (JSON, para fidelidad total de los datos) */
const VERSION_RESPALDO = 1;
function generarRespaldoCompleto(creditos, historicoIBR, configuracion, auditoria) {
  return { version: VERSION_RESPALDO, generadoEl: new Date().toISOString(), creditos, historicoIBR, configuracion, auditoria };
}
function descargarRespaldoCompleto(creditos, historicoIBR, configuracion, auditoria) {
  const respaldo = generarRespaldoCompleto(creditos, historicoIBR, configuracion, auditoria);
  const blob = new Blob([JSON.stringify(respaldo, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Respaldo_SADF_${fechaHoraArchivo()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Valida la integridad estructural de un archivo de respaldo antes de
// restaurarlo — nunca se sobrescriben los datos actuales sin esta validación.
function validarRespaldo(datos) {
  const errores = [];
  if (!datos || typeof datos !== "object") { errores.push("El archivo no tiene un formato reconocible."); return { valido: false, errores }; }
  if (!Array.isArray(datos.creditos)) errores.push("Falta el arreglo de créditos o no tiene el formato esperado.");
  if (!Array.isArray(datos.historicoIBR)) errores.push("Falta el arreglo de histórico de IBR o no tiene el formato esperado.");
  if (datos.creditos) {
    datos.creditos.forEach((c, i) => {
      if (!c.numeroObligacion || !c.banco || !c.fechaDesembolso || !c.fechaVencimiento) errores.push(`Crédito en la posición ${i + 1} no tiene los campos mínimos (banco, número de obligación, fechas).`);
    });
  }
  if (datos.historicoIBR) {
    datos.historicoIBR.forEach((t, i) => {
      if (!t.fecha || typeof t.valorEA !== "number") errores.push(`Tasa IBR en la posición ${i + 1} no tiene fecha o valor numérico válido.`);
    });
  }
  return { valido: errores.length === 0, errores };
}

/* 6.5 — Asistente de importación (UI) */
function ResumenPill({ color, bg, label, valor }) {
  return (
    <div style={{ background: bg, color, borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
      <div style={{ fontSize: 11 }}>{label}</div>
      <div className="sdf-num" style={{ fontSize: 20, fontWeight: 700 }}>{valor}</div>
    </div>
  );
}

function AsistenteImportar({ tipo, onCerrar }) {
  const { creditos, historicoIBR, importarCreditosLote, importarTasasIBRLote } = useApp();
  const cfg = CONFIG_IMPORTACION[tipo];
  const [paso, setPaso] = useState("subir");
  const [progreso, setProgreso] = useState(0);
  const [resultadoValidacion, setResultadoValidacion] = useState(null);
  const [autorizarParcial, setAutorizarParcial] = useState(false);
  const [resultadoFinal, setResultadoFinal] = useState(null);
  const [errorArchivo, setErrorArchivo] = useState(null);

  const procesarArchivo = async (file) => {
    setErrorArchivo(null);
    setPaso("procesando"); setProgreso(0);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const filasCrudas = leerFilasDesdeHoja(ws, cfg.primerEncabezado);
      const total = filasCrudas.length;
      if (total === 0) { setErrorArchivo("El archivo no contiene registros para importar."); setPaso("subir"); return; }

      const contexto = cfg.construirContexto(creditos, historicoIBR);
      const validas = []; const conError = []; let advertenciasTotal = 0;
      for (let i = 0; i < total; i++) {
        const filaMapeada = {};
        Object.entries(filasCrudas[i]).forEach(([h, v]) => { filaMapeada[cfg.mapaEncabezados[h.trim()] || h] = v; });
        const r = cfg.validarFila(filaMapeada, contexto);
        if (r.advertencias.length) advertenciasTotal += r.advertencias.length;
        (r.valido ? validas : conError).push({ fila: i + 2, ...r });
        setProgreso(Math.round(((i + 1) / total) * 100));
        if (i % 20 === 0) await new Promise((res) => setTimeout(res, 15));
      }
      setResultadoValidacion({ total, validas, conError, advertenciasTotal });
      setPaso("resumen");
    } catch (e) {
      setErrorArchivo("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx) válido basado en la plantilla.");
      setPaso("subir");
    }
  };

  const confirmarImportacion = () => {
    const { validas, conError } = resultadoValidacion;
    if (tipo === "creditos") importarCreditosLote(validas.map((v) => v.dato));
    else importarTasasIBRLote(validas.map((v) => v.dato));
    setResultadoFinal({ importados: validas.length, rechazados: conError.length });
    setPaso("resultado");
  };

  const descargarDetalleErrores = () => {
    const columnas = [
      { header: "Fila", key: "fila", ancho: 8, formato: "numero" },
      { header: "Errores", key: "erroresTexto", ancho: 60 },
      { header: "Advertencias", key: "advertenciasTexto", ancho: 60 },
    ];
    const filas = resultadoValidacion.conError.map((e) => ({ fila: e.fila, erroresTexto: e.errores.join(" | "), advertenciasTexto: e.advertencias.join(" | ") }));
    const ws = construirHoja("Detalle de errores de importación", cfg.titulo, columnas, filas);
    descargarLibro([{ nombre: "Errores", ws }], "Errores_Importacion");
  };

  const puedeConfirmar = resultadoValidacion && resultadoValidacion.validas.length > 0 && (resultadoValidacion.conError.length === 0 || autorizarParcial);

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(14,26,43,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 16 }}>
      <Card style={{ width: 640, maxWidth: "100%", maxHeight: "86vh", overflowY: "auto" }} className="sdf-scrollbar">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, margin: 0 }}>{cfg.titulo}</h2>
          <button onClick={onCerrar} aria-label="Cerrar asistente" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)" }}><X size={20} /></button>
        </div>

        {paso === "subir" && (
          <div>
            <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6 }}>Suba un archivo Excel (.xlsx) siguiendo la plantilla oficial. Puede descargar una plantilla vacía con ejemplo e instrucciones.</p>
            {errorArchivo && <div style={{ display: "flex", gap: 8, background: "var(--rose-soft)", color: "var(--rose)", padding: "9px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}><AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />{errorArchivo}</div>}
            <Boton variant="ghost" onClick={cfg.descargarPlantilla} style={{ marginBottom: 16 }}><Download size={14} /> Descargar plantilla</Boton>
            <div>
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files[0] && procesarArchivo(e.target.files[0])} aria-label="Seleccionar archivo Excel" style={{ fontSize: 13 }} />
            </div>
          </div>
        )}

        {paso === "procesando" && (
          <div style={{ padding: "16px 0" }}>
            <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 10 }}>Procesando registros… {progreso}%</div>
            <div style={{ height: 8, background: "var(--line-soft)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progreso}%`, background: "var(--teal)", transition: "width 120ms ease" }} />
            </div>
          </div>
        )}

        {paso === "resumen" && resultadoValidacion && (
          <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <ResumenPill bg="var(--teal-soft)" color="var(--teal-strong)" label="Registros válidos" valor={resultadoValidacion.validas.length} />
              <ResumenPill bg="var(--rose-soft)" color="var(--rose)" label="Registros con error" valor={resultadoValidacion.conError.length} />
              <ResumenPill bg="var(--amber-soft)" color="var(--amber)" label="Advertencias" valor={resultadoValidacion.advertenciasTotal} />
            </div>

            {resultadoValidacion.conError.length > 0 && (
              <>
                <div className="sdf-scrollbar" style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ background: "var(--paper)" }}><th style={thStyle}>Fila</th><th style={thStyle}>Motivo</th></tr></thead>
                    <tbody>
                      {resultadoValidacion.conError.map((e, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                          <td style={{ padding: "6px 10px" }} className="sdf-num">{e.fila}</td>
                          <td style={{ padding: "6px 10px", color: "var(--rose)" }}>{e.errores.join(" · ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Boton variant="ghost" size="chico" onClick={descargarDetalleErrores} style={{ marginBottom: 14 }}><Download size={13} /> Descargar detalle de errores</Boton>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, marginBottom: 14, color: "var(--ink)" }}>
                  <input type="checkbox" checked={autorizarParcial} onChange={(e) => setAutorizarParcial(e.target.checked)} style={{ marginTop: 2 }} />
                  Autorizo importar únicamente los {resultadoValidacion.validas.length} registros válidos; los {resultadoValidacion.conError.length} con error no se importarán.
                </label>
              </>
            )}

            {resultadoValidacion.advertenciasTotal > 0 && resultadoValidacion.conError.length === 0 && (
              <div style={{ display: "flex", gap: 8, background: "var(--amber-soft)", color: "var(--amber)", padding: "9px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 14 }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> Hay {resultadoValidacion.advertenciasTotal} advertencia(s) (por ejemplo, tasas que reemplazarán valores existentes). No impiden la importación.
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <Boton onClick={confirmarImportacion} disabled={!puedeConfirmar} style={!puedeConfirmar ? { opacity: 0.5, cursor: "not-allowed" } : {}}><Check size={14} /> Confirmar importación</Boton>
              <Boton variant="ghost" onClick={onCerrar}>Cancelar</Boton>
            </div>
          </div>
        )}

        {paso === "resultado" && resultadoFinal && (
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <Check size={18} color="var(--teal-strong)" />
              <strong>{resultadoFinal.importados} registro(s) importado(s) correctamente.</strong>
            </div>
            {resultadoFinal.rechazados > 0 && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>{resultadoFinal.rechazados} registro(s) no se importaron por tener errores. Puede volver a descargar el detalle desde el resumen si aún lo necesita.</p>}
            <Boton onClick={onCerrar}>Cerrar</Boton>
          </div>
        )}
      </Card>
    </div>
  );
}


function Contenido() {
  const { modulo } = useApp();
  switch (modulo) {
    case "inicio": return <ModuloInicio />;
    case "creditos": return <ModuloCreditos />;
    case "ibr": return <ModuloIBR />;
    case "cronograma": return <ModuloCronograma />;
    case "causacion": return <ModuloCausacion />;
    case "flujo": return <ModuloFlujo />;
    case "dashboard": return <ModuloDashboard />;
    case "configuracion": return <ModuloConfiguracion />;
    default: return <ModuloInicio />;
  }
}

function PantallaCargaInicial() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--paper)" }}>
      <div style={{ textAlign: "center" }}>
        <span style={{ width: 22, height: 22, display: "inline-block", borderRadius: "50%", border: "2.5px solid var(--line)", borderTopColor: "var(--teal)", animation: "sdf-spin 700ms linear infinite" }} />
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--ink-soft)" }}>Cargando información guardada…</div>
      </div>
    </div>
  );
}

function AppShell() {
  const { cargandoInicial } = useApp();
  if (cargandoInicial) return <PantallaCargaInicial />;
  return (
    <div className="sdf-root" style={{ display: "flex" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <HeaderGlobal />
        <main style={{ flex: 1 }}>
          <Contenido />
        </main>
      </div>
    </div>
  );
}

export default function SistemaDeudaFinanciera({ user }) {
  useEffect(() => {
    const link1 = document.createElement("link");
    link1.rel = "stylesheet";
    link1.href = "https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(link1);
    return () => document.head.removeChild(link1);
  }, []);

  return (
    <ErrorBoundary>
      <AppProvider user={user}>
        <style>{TOKENS}{`@keyframes sdf-spin{to{transform:rotate(360deg);}}`}</style>
        <AppShell />
        <ToastCentro />
      </AppProvider>
    </ErrorBoundary>
  );
}
