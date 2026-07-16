/* ==========================================================================
   PORTAL IMPERIAL — Sistema POS (Comida China · Floridablanca, Colombia)
   Plan PROFESIONAL · WALLACE COMPANY SYSTEM — Ing. Roldán Aldana
   wallacecompany11@gmail.com
   --------------------------------------------------------------------------
   app.js — Lógica completa del sistema
   Módulos: login/roles, pedidos (mesa/llevar/domicilio), clientes,
   caja y cobros, KDS cocina, impresión, reportes, inventario+recetas,
   auditoría, sincronización Firebase multidispositivo.
   ========================================================================== */
'use strict';

/* =======================================================================
   0. CONSTANTES DE NEGOCIO (personalizadas para Portal Imperial)
   ======================================================================= */
const NEGOCIO = {
  nombre:    'Portal Imperial',
  rubro:     'Comida China',
  ciudad:    'Floridablanca, Colombia',
  nit:       '',                       // completar si aplica
  direccion: 'CRA 40 # 204-20',
  telefono:  '3105314107',
  correo:    'wallacecompany11@gmail.com',
  prefijoFactura: 'PI',                // PI-000001
  numMesas:  10,
  tzOffset:  (typeof window.TZ_OFFSET_HORAS === 'number') ? window.TZ_OFFSET_HORAS : -5,
  metodosPago: ['efectivo', 'banco', 'tarjeta'],
};

/* =======================================================================
   1. ZONA HORARIA — REGLA DE ORO (Parte 6.5, error 1)
   GUARDAR en UTC (toISOString). CONVERTIR a local SOLO al mostrar.
   El "tiempo transcurrido" se calcula con instantes UTC, SIN offset.
   ======================================================================= */
let SERVER_OFFSET = 0; // corrección reloj cliente vs servidor (ms), se calibra con Firebase

function ahoraMs(){ return Date.now() + SERVER_OFFSET; }
function ahoraISO(){ return new Date(ahoraMs()).toISOString(); } // <- SIEMPRE guardar así

// Convierte un instante (ISO o ms) a un Date "desplazado" a hora local del negocio.
// USAR SOLO para mostrar/formatear o calcular el día de operación. Nunca para guardar.
function aLocal(fechaISOoMs){
  const ms = (typeof fechaISOoMs === 'number') ? fechaISOoMs : new Date(fechaISOoMs).getTime();
  return new Date(ms + NEGOCIO.tzOffset * 3600 * 1000);
}
function fmtHora(fechaISOoMs){
  const d = aLocal(fechaISOoMs);
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  const ss = String(d.getUTCSeconds()).padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}
function fmtFecha(fechaISOoMs){
  const d = aLocal(fechaISOoMs);
  const dd = String(d.getUTCDate()).padStart(2,'0');
  const mo = String(d.getUTCMonth()+1).padStart(2,'0');
  const yy = d.getUTCFullYear();
  return `${dd}/${mo}/${yy}`;
}
function fmtFechaHora(fechaISOoMs){ return `${fmtFecha(fechaISOoMs)} ${fmtHora(fechaISOoMs)}`; }

// Clave "día de operación" (YYYY-MM-DD en hora local). Solo para agrupar historial.
function diaLocalClave(fechaISOoMs){
  const d = aLocal(fechaISOoMs);
  const dd = String(d.getUTCDate()).padStart(2,'0');
  const mo = String(d.getUTCMonth()+1).padStart(2,'0');
  return `${d.getUTCFullYear()}-${mo}-${dd}`;
}
// Minutos transcurridos desde un instante UTC (SIN offset — error 1).
function minutosDesde(fechaISOoMs){
  const ms = (typeof fechaISOoMs==='number') ? fechaISOoMs : new Date(fechaISOoMs).getTime();
  return Math.floor((ahoraMs() - ms) / 60000);
}
function segundosDesde(fechaISOoMs){
  const ms = (typeof fechaISOoMs==='number') ? fechaISOoMs : new Date(fechaISOoMs).getTime();
  return Math.floor((ahoraMs() - ms) / 1000);
}

/* =======================================================================
   2. FORMATO DE MONEDA (peso colombiano, punto de miles)
   ======================================================================= */
function pesos(n){
  n = Math.round(Number(n) || 0);
  const neg = n < 0;
  n = Math.abs(n);
  const s = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-$ ' : '$ ') + s;
}
function soloMiles(n){
  n = Math.round(Number(n) || 0);
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function num(v){ const n = Number(String(v).replace(/[^\d.-]/g,'')); return isNaN(n)?0:n; }

/* =======================================================================
   3. IDENTIFICADORES ÚNICOS
   ======================================================================= */
function uid(prefijo){
  return (prefijo||'id') + '_' + Date.now().toString(36) + '_' +
         Math.random().toString(36).slice(2, 8);
}

/* =======================================================================
   4. CAPA DE DATOS — Firebase Realtime DB + CACHE + localStorage
   Sincronización multidispositivo. Fusión segura para no pisar datos.
   ======================================================================= */
let fbApp = null, fbDB = null, FB_OK = false;
const CACHE = {};                 // espejo en memoria de toda la data
const LS_KEY = 'PORTAL_IMPERIAL_POS';
const suscriptores = {};          // nodo -> [callbacks]

function lsGuardar(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(CACHE)); } catch(e){}
}
function lsCargar(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(CACHE, JSON.parse(raw));
  } catch(e){}
}

function initFirebase(){
  try {
    if (!window.FIREBASE_CONFIG || String(window.FIREBASE_CONFIG.apiKey).startsWith('PEGA_AQUI')){
      console.warn('[Firebase] Sin credenciales reales: modo LOCAL (solo este dispositivo).');
      FB_OK = false;
      return false;
    }
    if (!window.firebase){ console.warn('[Firebase] SDK no cargado.'); FB_OK=false; return false; }
    fbApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    fbDB  = firebase.database();
    FB_OK = true;
    calibrarReloj();
    return true;
  } catch(e){
    console.error('[Firebase] Error init:', e);
    FB_OK = false;
    return false;
  }
}

// Calibra el reloj local contra el servidor (para ahoraMs()).
function calibrarReloj(){
  if (!FB_OK) return;
  try {
    fbDB.ref('.info/serverTimeOffset').on('value', s => {
      const off = s.val();
      if (typeof off === 'number') SERVER_OFFSET = off;
    });
  } catch(e){}
}

// Lee un nodo completo (devuelve del CACHE; útil sincrónicamente).
function DBget(nodo){ return CACHE[nodo]; }

// Escribe/reemplaza un nodo completo. Para colecciones grandes preferir fusión.
function DBset(nodo, valor){
  CACHE[nodo] = valor;
  lsGuardar();
  notificar(nodo);
  if (FB_OK){
    fbDB.ref(nodo).set(valor).catch(e => console.error('[DBset]', nodo, e));
  }
}

// Suscripción a cambios de un nodo (tiempo real).
function DBon(nodo, cb){
  (suscriptores[nodo] = suscriptores[nodo] || []).push(cb);
  if (FB_OK){
    fbDB.ref(nodo).on('value', snap => {
      CACHE[nodo] = snap.val();
      lsGuardar();
      cb(CACHE[nodo]);
    });
  } else {
    cb(CACHE[nodo]); // modo local: dispara una vez con lo que haya
  }
}
function notificar(nodo){
  (suscriptores[nodo] || []).forEach(cb => { try{ cb(CACHE[nodo]); }catch(e){} });
}

/* -----------------------------------------------------------------------
   4.1 VENTAS — Escritura segura por FUSIÓN (Parte 6.5, error 2) — CRÍTICO
   Nunca sobrescribir el array completo: dos dispositivos se borrarían
   pedidos entre sí. Fusionamos por ID.
   ----------------------------------------------------------------------- */
function ventasObj(){
  // CACHE.ventas es un objeto { idVenta: venta }
  if (!CACHE.ventas || typeof CACHE.ventas !== 'object') CACHE.ventas = {};
  return CACHE.ventas;
}
function ventasArray(){
  return Object.values(ventasObj()).filter(Boolean);
}

// Guarda/actualiza UNA venta sin tocar las demás.
function fusionarYGuardarVentas(venta){
  if (!venta || !venta.id) { console.error('Venta sin id'); return; }
  const obj = ventasObj();
  obj[venta.id] = venta;
  CACHE.ventas = obj;
  lsGuardar();
  notificar('ventas');
  if (FB_OK){
    // Escritura puntual solo de esa venta: no pisa el resto.
    fbDB.ref('ventas/' + venta.id).set(venta)
      .catch(e => console.error('[fusionarYGuardarVentas]', e));
  }
}

// Borra UNA venta de forma segura (individual).
function borrarVentaSegura(id){
  if (!id) return;
  const obj = ventasObj();
  delete obj[id];
  CACHE.ventas = obj;
  lsGuardar();
  notificar('ventas');
  if (FB_OK){
    fbDB.ref('ventas/' + id).remove()
      .catch(e => console.error('[borrarVentaSegura]', e));
  }
}

// Suscripción a ventas (tiempo real, mantiene CACHE.ventas como objeto).
function suscribirVentas(cb){
  if (FB_OK){
    fbDB.ref('ventas').on('value', snap => {
      CACHE.ventas = snap.val() || {};
      lsGuardar();
      cb(ventasArray());
    });
  } else {
    cb(ventasArray());
  }
}

/* =======================================================================
   5. USUARIOS Y ROLES (Parte 3.1)
   Permisos por rol. Admin: total. Ver matriz PERMISOS.
   ======================================================================= */
const ROLES = ['admin','supervisor','jefe','cajero','mesero','cocina','impresiones'];

// Usuarios demo iniciales (el admin debe cambiarlos). clave en claro solo demo.
const USUARIOS_DEMO = {
  admin:      { usuario:'admin',      clave:'admin123',  rol:'admin',      nombre:'Administrador' },
  supervisor: { usuario:'supervisor', clave:'super123',  rol:'supervisor', nombre:'Supervisor' },
  jefe:       { usuario:'jefe',       clave:'jefe123',   rol:'jefe',       nombre:'Jefe' },
  cajero:     { usuario:'cajero',     clave:'caja123',   rol:'cajero',     nombre:'Cajero' },
  mesero:     { usuario:'mesero',     clave:'mesa123',   rol:'mesero',     nombre:'Mesero' },
  cocina:     { usuario:'cocina',     clave:'coci123',   rol:'cocina',     nombre:'Cocina' },
};

// Matriz de permisos (true = permitido).
const PERMISOS = {
  verDashboard:      { admin:1, supervisor:1, jefe:1, cajero:1, mesero:0, cocina:0, impresiones:0 },
  tomarPedido:       { admin:1, supervisor:1, jefe:1, cajero:1, mesero:1, cocina:0, impresiones:0 },
  editarMesaAbierta: { admin:1, supervisor:1, jefe:1, cajero:1, mesero:1, cocina:0, impresiones:0 },
  cobrar:            { admin:1, supervisor:1, jefe:1, cajero:1, mesero:0, cocina:0, impresiones:0 },
  abrirCaja:         { admin:1, supervisor:1, jefe:1, cajero:1, mesero:0, cocina:0, impresiones:0 },
  cerrarCaja:        { admin:1, supervisor:1, jefe:1, cajero:1, mesero:0, cocina:0, impresiones:0 },
  eliminarFactura:   { admin:1, supervisor:1, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  quitarProducto:    { admin:1, supervisor:1, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  editarPago:        { admin:1, supervisor:1, jefe:0, cajero:1, mesero:0, cocina:0, impresiones:0 },
  anularPedido:      { admin:1, supervisor:1, jefe:1, cajero:1, mesero:0, cocina:0, impresiones:0 },
  verAuditoria:      { admin:1, supervisor:0, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  verInventario:     { admin:1, supervisor:1, jefe:1, cajero:0, mesero:0, cocina:0, impresiones:0 },
  editarInventario:  { admin:1, supervisor:1, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  gestionUsuarios:   { admin:1, supervisor:0, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  verConfig:         { admin:1, supervisor:0, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  diagnosticoCaja:   { admin:1, supervisor:0, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  retiroCajaCerrada: { admin:1, supervisor:1, jefe:0, cajero:0, mesero:0, cocina:0, impresiones:0 },
  verCocina:         { admin:1, supervisor:1, jefe:1, cajero:1, mesero:1, cocina:1, impresiones:1 },
  verReportes:       { admin:1, supervisor:1, jefe:1, cajero:1, mesero:0, cocina:0, impresiones:0 },
};
function puede(accion){
  const u = ESTADO.usuario;
  if (!u) return false;
  const m = PERMISOS[accion];
  if (!m) return false;
  return !!m[u.rol];
}

/* =======================================================================
   6. ESTADO GLOBAL EN MEMORIA
   ======================================================================= */
const ESTADO = {
  usuario: null,          // usuario logueado
  vista: 'login',         // vista actual
  cajaActual: null,       // objeto caja abierta (o null)
  pedidoEnCurso: null,    // pedido que se está armando
  ventas: [],             // cache de ventas (array) para render
  usuarios: {},           // usuarios del sistema
  menu: {},               // { categoria: [productos] }
  insumos: {},            // inventario de materia prima
  recetas: {},            // productoId -> [{insumoId, cantidad}]
  clientes: {},           // clientes guardados (nombre/telefono)
  domiciliarios: [],      // lista de domiciliarios
  auditoria: [],          // registro de acciones sensibles
  contadorOrden: 0,       // # de orden de cocina (reinicia al abrir caja)
  llamadoMesero: null,    // {tick, mesa} para sonar en mesero
  bloqueado: false,       // bloqueo de pantalla (F8)
};

/* =======================================================================
   7. MENÚ SEMILLA — Comida China (editable desde la interfaz)
   ======================================================================= */
const MENU_SEMILLA = {
  'Arroces': [
    { id:'p_arroz_esp',  nombre:'Arroz Especial Portal Imperial', precio:22000, agotado:false },
    { id:'p_arroz_pollo',nombre:'Arroz Chino con Pollo',          precio:18000, agotado:false },
    { id:'p_arroz_cerdo',nombre:'Arroz Chino con Cerdo',          precio:18000, agotado:false },
    { id:'p_arroz_mixto',nombre:'Arroz Mixto (pollo y cerdo)',    precio:20000, agotado:false },
    { id:'p_arroz_camar',nombre:'Arroz con Camarones',            precio:24000, agotado:false },
  ],
  'Tallarines': [
    { id:'p_tall_pollo', nombre:'Tallarín con Pollo',   precio:19000, agotado:false },
    { id:'p_tall_mixto', nombre:'Tallarín Mixto',       precio:21000, agotado:false },
    { id:'p_tall_camar', nombre:'Tallarín con Camarón', precio:25000, agotado:false },
  ],
  'Especiales': [
    { id:'p_agridulce',  nombre:'Pollo Agridulce',          precio:23000, agotado:false },
    { id:'p_costilla',   nombre:'Costilla en Salsa BBQ',    precio:26000, agotado:false },
    { id:'p_apanado',    nombre:'Cerdo Apanado',            precio:22000, agotado:false },
    { id:'p_rollo',      nombre:'Rollos Primavera (x3)',    precio:12000, agotado:false },
  ],
  'Sopas': [
    { id:'p_sopa_wan',   nombre:'Sopa Wantán',       precio:14000, agotado:false },
    { id:'p_sopa_maiz',  nombre:'Sopa de Maíz',      precio:12000, agotado:false },
  ],
  'Bebidas': [
    { id:'p_gaseosa',    nombre:'Gaseosa Personal',  precio:4000,  agotado:false },
    { id:'p_jugo',       nombre:'Jugo Natural',      precio:6000,  agotado:false },
    { id:'p_te',         nombre:'Té Chino',          precio:5000,  agotado:false },
    { id:'p_agua',       nombre:'Agua',              precio:3000,  agotado:false },
  ],
};

/* =======================================================================
   8. INICIALIZACIÓN DE DATOS (siembra si está vacío)
   ======================================================================= */
function inicializarDatos(){
  if (!CACHE.usuarios) DBset('usuarios', USUARIOS_DEMO);
  ESTADO.usuarios = CACHE.usuarios || USUARIOS_DEMO;

  if (!CACHE.menu) DBset('menu', MENU_SEMILLA);
  ESTADO.menu = CACHE.menu || MENU_SEMILLA;

  if (!CACHE.insumos) DBset('insumos', {});
  ESTADO.insumos = CACHE.insumos || {};

  if (!CACHE.recetas) DBset('recetas', {});
  ESTADO.recetas = CACHE.recetas || {};

  if (!CACHE.clientes) DBset('clientes', {});
  ESTADO.clientes = CACHE.clientes || {};

  if (!CACHE.domiciliarios) DBset('domiciliarios', ['Domiciliario 1','Domiciliario 2']);
  ESTADO.domiciliarios = CACHE.domiciliarios || [];

  if (!CACHE.auditoria) DBset('auditoria', []);
  ESTADO.auditoria = CACHE.auditoria || [];

  if (!CACHE.ventas) CACHE.ventas = {};
  ESTADO.ventas = ventasArray();

  ESTADO.cajaActual = CACHE.cajaActual || null;
  ESTADO.contadorOrden = (CACHE.cajaActual && CACHE.cajaActual.contadorOrden) || 0;
}

/* =======================================================================
   9. AUDITORÍA (Parte 3.6)
   ======================================================================= */
function registrarAuditoria(accion, detalle){
  const reg = {
    id: uid('aud'),
    fecha: ahoraISO(),
    usuario: ESTADO.usuario ? ESTADO.usuario.usuario : '?',
    rol: ESTADO.usuario ? ESTADO.usuario.rol : '?',
    accion, detalle: detalle || ''
  };
  const arr = Array.isArray(CACHE.auditoria) ? CACHE.auditoria.slice() : [];
  arr.unshift(reg);
  // conservar últimos 500
  DBset('auditoria', arr.slice(0, 500));
  ESTADO.auditoria = CACHE.auditoria;
}

/* =======================================================================
   10. CAJA Y COBROS — NÚCLEO CRÍTICO (Parte 3.5 y 6.5)
   Conceptos SIEMPRE separados: comida / propina / domicilio / recargo.
   ======================================================================= */

// Abre una caja nueva. Base obligatoria. Reinicia contador de orden de cocina.
function abrirCaja(base, cajero){
  if (ESTADO.cajaActual){ alert('Ya hay una caja abierta.'); return false; }
  base = num(base);
  const caja = {
    id: uid('caja'),
    abierta: true,
    fechaApertura: ahoraISO(),
    fechaCierre: null,
    cajero: cajero || (ESTADO.usuario && ESTADO.usuario.usuario),
    base: base,
    movimientos: [],          // {tipo:'gasto'|'entrada'|'retiro'|'nomina', valor, motivo, fecha, usuario}
    contadorOrden: 0,
    contadorFactura: (CACHE.ultimoNumFactura || 0),
  };
  ESTADO.cajaActual = caja;
  ESTADO.contadorOrden = 0;
  DBset('cajaActual', caja);
  registrarAuditoria('ABRIR_CAJA', 'Base: ' + pesos(base));
  return true;
}

// Registra un movimiento de caja (gasto, entrada, retiro, nómina).
function movimientoCaja(tipo, valor, motivo){
  if (!ESTADO.cajaActual){ alert('No hay caja abierta.'); return; }
  const mov = {
    id: uid('mov'), tipo, valor: num(valor), motivo: motivo||'',
    fecha: ahoraISO(), usuario: ESTADO.usuario && ESTADO.usuario.usuario
  };
  ESTADO.cajaActual.movimientos = ESTADO.cajaActual.movimientos || [];
  ESTADO.cajaActual.movimientos.push(mov);
  DBset('cajaActual', ESTADO.cajaActual);
  if (tipo === 'retiro' || tipo === 'nomina' || tipo === 'gasto'){
    registrarAuditoria('MOV_CAJA_' + tipo.toUpperCase(), pesos(valor) + ' · ' + (motivo||''));
  }
}

/* -----------------------------------------------------------------------
   10.1 VENTAS DE LA CAJA ACTUAL
   El "día de operación" es por CAJA (cajaId), no por reloj (Parte 6.5, err 5).
   ----------------------------------------------------------------------- */
function ventasDeCaja(cajaId){
  return ventasArray().filter(v => v.cajaId === cajaId && v.estado !== 'anulada');
}
function ventasCajaActual(){
  if (!ESTADO.cajaActual) return [];
  return ventasDeCaja(ESTADO.cajaActual.id);
}

/* -----------------------------------------------------------------------
   10.2 FÓRMULA DEL EFECTIVO ESPERADO — recalculada EN VIVO (error 4)
   NO confiar en valores guardados al cobrar.
   Efectivo esperado = base
                     + comida pagada en efectivo
                     + entradas extra
                     - gastos/nómina - retiros
                     - (propinas y domicilios que ENTRARON por banco/tarjeta
                        y se pagan en efectivo a su dueño)
   El RECARGO del datáfono NO se resta (se lo queda el banco).
   ----------------------------------------------------------------------- */
function calcularEfectivoEsperado(caja){
  caja = caja || ESTADO.cajaActual;
  if (!caja) return 0;

  let esperado = num(caja.base);
  let salidasElectronicoAEfectivo = 0;

  ventasDeCaja(caja.id).forEach(v => {
    // 1) Comida pagada en EFECTIVO entra al cajón.
    const pv = v.pagosVenta || {};
    esperado += num(pv.efectivo);

    // 2) Propina que entró por banco/tarjeta pero se paga al mesero en efectivo -> SALE.
    if (v.propina && v.propinaMetodo && v.propinaMetodo !== 'efectivo'){
      salidasElectronicoAEfectivo += num(v.propina);
    }
    // 3) Domicilio que entró por banco/tarjeta y se paga al domiciliario en efectivo -> SALE.
    //    (En efectivo, el domicilio NO pasa por caja, así que no suma ni resta.)
    if (v.valorDom && v.domMetodo && v.domMetodo !== 'efectivo'){
      salidasElectronicoAEfectivo += num(v.valorDom);
    }
    // 4) RECARGO de datáfono: NUNCA sale del cajón. No se resta. (error 4)
  });

  // Movimientos de caja
  (caja.movimientos || []).forEach(m => {
    if (m.tipo === 'entrada') esperado += num(m.valor);
    else esperado -= num(m.valor); // gasto, nomina, retiro
  });

  esperado -= salidasElectronicoAEfectivo;
  return Math.round(esperado);
}

// Desglose para el diagnóstico de efectivo (solo admin).
function diagnosticoEfectivo(caja){
  caja = caja || ESTADO.cajaActual;
  if (!caja) return null;
  const d = {
    base: num(caja.base),
    comidaEfectivo: 0,
    entradas: 0, gastos: 0, retiros: 0, nomina: 0,
    salidaPropinaBanco: 0, salidaDomicilioBanco: 0,
    recargoTotal: 0, // informativo, NO afecta caja
    detallePedidos: []
  };
  ventasDeCaja(caja.id).forEach(v => {
    const pv = v.pagosVenta || {};
    d.comidaEfectivo += num(pv.efectivo);
    if (v.propina && v.propinaMetodo && v.propinaMetodo!=='efectivo') d.salidaPropinaBanco += num(v.propina);
    if (v.valorDom && v.domMetodo && v.domMetodo!=='efectivo') d.salidaDomicilioBanco += num(v.valorDom);
    d.recargoTotal += num(v.recargo);
    d.detallePedidos.push({
      factura: v.factura || v.cliente || v.id,
      comida: v.totalComida, pagos: pv,
      propina: v.propina, propinaMetodo: v.propinaMetodo,
      valorDom: v.valorDom, domMetodo: v.domMetodo,
      recargo: v.recargo
    });
  });
  (caja.movimientos||[]).forEach(m=>{
    if (m.tipo==='entrada') d.entradas+=num(m.valor);
    else if (m.tipo==='gasto') d.gastos+=num(m.valor);
    else if (m.tipo==='retiro') d.retiros+=num(m.valor);
    else if (m.tipo==='nomina') d.nomina+=num(m.valor);
  });
  d.esperado = calcularEfectivoEsperado(caja);
  return d;
}

/* -----------------------------------------------------------------------
   10.3 TOTALES POR MÉTODO (para el cierre) — solo COMIDA (no propina/recargo)
   ----------------------------------------------------------------------- */
function totalesPorMetodo(caja){
  caja = caja || ESTADO.cajaActual;
  const t = { efectivo:0, banco:0, tarjeta:0, totalComida:0,
              propinas:0, domicilios:0, recargos:0, numVentas:0 };
  if (!caja) return t;
  ventasDeCaja(caja.id).forEach(v => {
    const pv = v.pagosVenta || {};
    t.efectivo += num(pv.efectivo);
    t.banco    += num(pv.banco);
    t.tarjeta  += num(pv.tarjeta);
    t.totalComida += num(v.totalComida);
    t.propinas += num(v.propina);
    t.domicilios += num(v.valorDom);
    t.recargos += num(v.recargo);
    t.numVentas++;
  });
  return t;
}

/* -----------------------------------------------------------------------
   10.4 CERRAR CAJA — avisa pedidos sin cobrar, guarda historial (Parte 3.5)
   ----------------------------------------------------------------------- */
function pedidosSinCobrarCajaActual(){
  if (!ESTADO.cajaActual) return [];
  return ventasArray().filter(v =>
    v.cajaId === ESTADO.cajaActual.id &&
    v.estado !== 'anulada' &&
    !v.pagado);
}

function cerrarCaja(efectivoContado, confirmarPendientes){
  if (!ESTADO.cajaActual){ alert('No hay caja abierta.'); return false; }

  const pendientes = pedidosSinCobrarCajaActual();
  if (pendientes.length && !confirmarPendientes){
    return { requiereConfirmacion:true, pendientes };
  }

  const caja = ESTADO.cajaActual;
  const esperado = calcularEfectivoEsperado(caja);
  const contado  = num(efectivoContado);
  const diferencia = contado - esperado;
  const t = totalesPorMetodo(caja);

  const cierre = {
    id: uid('cierre'),
    cajaId: caja.id,
    fecha: ahoraISO(),
    dia: diaLocalClave(ahoraISO()),
    cajero: caja.cajero,
    base: num(caja.base),
    fechaApertura: caja.fechaApertura,
    fechaCierre: ahoraISO(),
    totalVentas: t.totalComida,
    porMetodo: { efectivo:t.efectivo, banco:t.banco, tarjeta:t.tarjeta },
    propinas: t.propinas, domicilios: t.domicilios, recargos: t.recargos,
    movimientos: caja.movimientos || [],
    esperado, contado, diferencia,
    resultado: diferencia === 0 ? 'CUADRADA' : (diferencia > 0 ? 'SOBRA' : 'FALTA'),
  };

  // Guardar en historial (conservar mes actual y anterior).
  let hist = Array.isArray(CACHE.historialCierres) ? CACHE.historialCierres.slice() : [];
  hist.unshift(cierre);
  hist = limpiarHistorialCierres(hist);
  DBset('historialCierres', hist);

  // Guardar último número de factura para continuidad.
  DBset('ultimoNumFactura', caja.contadorFactura || 0);

  // Cerrar caja.
  caja.abierta = false;
  caja.fechaCierre = cierre.fechaCierre;
  DBset('cajaActual', null);
  ESTADO.cajaActual = null;

  registrarAuditoria('CERRAR_CAJA',
    `Esperado ${pesos(esperado)} · Contado ${pesos(contado)} · ${cierre.resultado} ${pesos(diferencia)}`);

  return { ok:true, cierre };
}

// Conserva solo cierres del mes actual y el anterior (Parte 3.5).
function limpiarHistorialCierres(hist){
  const hoy = aLocal(ahoraISO());
  const mesActual = hoy.getUTCFullYear()*12 + hoy.getUTCMonth();
  return hist.filter(c => {
    const d = aLocal(c.fecha);
    const m = d.getUTCFullYear()*12 + d.getUTCMonth();
    return (mesActual - m) <= 1;
  });
}

/* -----------------------------------------------------------------------
   10.5 RETIRO CON CAJA CERRADA (admin/supervisor) — Parte 3.5
   ----------------------------------------------------------------------- */
function retiroCajaCerrada(valor, motivo){
  const reg = {
    id: uid('retiroCC'), valor: num(valor), motivo: motivo||'',
    fecha: ahoraISO(), usuario: ESTADO.usuario && ESTADO.usuario.usuario
  };
  const arr = Array.isArray(CACHE.retirosCajaCerrada) ? CACHE.retirosCajaCerrada.slice() : [];
  arr.unshift(reg);
  DBset('retirosCajaCerrada', arr.slice(0,200));
  registrarAuditoria('RETIRO_CAJA_CERRADA', pesos(valor)+' · '+(motivo||''));
}

/* =======================================================================
   11. INVENTARIO Y RECETAS (Parte 4) — descuento/devolución automáticos
   ======================================================================= */
function guardarInsumo(ins){
  const obj = (CACHE.insumos && typeof CACHE.insumos==='object') ? Object.assign({},CACHE.insumos) : {};
  if (!ins.id) ins.id = uid('ins');
  obj[ins.id] = ins;
  DBset('insumos', obj);
  ESTADO.insumos = obj;
  return ins.id;
}
function movimientoInsumo(insumoId, delta, motivo, tipo){
  const obj = Object.assign({}, CACHE.insumos || {});
  const ins = obj[insumoId];
  if (!ins) return;
  ins.stock = num(ins.stock) + num(delta);
  ins.historial = ins.historial || [];
  ins.historial.unshift({
    fecha: ahoraISO(), delta: num(delta), tipo: tipo||'ajuste',
    motivo: motivo||'', usuario: ESTADO.usuario && ESTADO.usuario.usuario,
    stockResultante: ins.stock
  });
  ins.historial = ins.historial.slice(0,300);
  obj[insumoId] = ins;
  DBset('insumos', obj);
  ESTADO.insumos = obj;
}
function guardarReceta(productoId, items){
  // items = [{insumoId, cantidad}]
  const obj = Object.assign({}, CACHE.recetas || {});
  obj[productoId] = items || [];
  DBset('recetas', obj);
  ESTADO.recetas = obj;
}

// Descuenta materia prima de un pedido (al pagar/entregar). Marca descontado.
function descontarInventarioPorVenta(venta){
  if (!venta || venta.inventarioDescontado) return;
  const recetas = CACHE.recetas || {};
  (venta.items || []).forEach(it => {
    const receta = recetas[it.productoId];
    if (!receta) return;
    receta.forEach(r => {
      movimientoInsumo(r.insumoId, -num(r.cantidad) * num(it.cantidad),
        'Venta ' + (venta.factura||venta.id), 'venta');
    });
  });
  venta.inventarioDescontado = true;
  fusionarYGuardarVentas(venta);
}
// Devuelve materia prima si se anula/elimina un pedido ya descontado.
function devolverInventarioPorVenta(venta){
  if (!venta || !venta.inventarioDescontado) return;
  const recetas = CACHE.recetas || {};
  (venta.items || []).forEach(it => {
    const receta = recetas[it.productoId];
    if (!receta) return;
    receta.forEach(r => {
      movimientoInsumo(r.insumoId, +num(r.cantidad) * num(it.cantidad),
        'Devolución ' + (venta.factura||venta.id), 'devolucion');
    });
  });
  venta.inventarioDescontado = false;
  fusionarYGuardarVentas(venta);
}
function insumosBajoMinimo(){
  return Object.values(CACHE.insumos || {}).filter(i =>
    num(i.stock) <= num(i.stockMinimo));
}

/* =======================================================================
   12. CLIENTES (Parte 3.2) — guardar todos; sugerencias, NO autorrelleno
   ======================================================================= */
function guardarCliente(cli){
  if (!cli || (!cli.nombre && !cli.telefono)) return;
  const obj = Object.assign({}, CACHE.clientes || {});
  const key = (cli.telefono || cli.nombre).toString().trim();
  obj[key] = Object.assign({}, obj[key], cli, { key });
  DBset('clientes', obj);
  ESTADO.clientes = obj;
}
// Devuelve lista de clientes que coinciden (para mostrar sugerencias).
function buscarClientes(texto){
  texto = (texto||'').toLowerCase().trim();
  if (!texto) return [];
  return Object.values(CACHE.clientes || {}).filter(c =>
    (c.nombre||'').toLowerCase().includes(texto) ||
    (c.telefono||'').toString().includes(texto)
  ).slice(0, 8);
}

/* =======================================================================
   13. PEDIDOS — crear, editar, numeración
   ======================================================================= */
function nuevoNumeroFactura(){
  if (!ESTADO.cajaActual) return null;
  ESTADO.cajaActual.contadorFactura = (ESTADO.cajaActual.contadorFactura || 0) + 1;
  const n = ESTADO.cajaActual.contadorFactura;
  DBset('cajaActual', ESTADO.cajaActual);
  return NEGOCIO.prefijoFactura + '-' + String(n).padStart(6,'0');
}
function nuevoNumeroOrden(){
  if (!ESTADO.cajaActual) return 1;
  ESTADO.cajaActual.contadorOrden = (ESTADO.cajaActual.contadorOrden || 0) + 1;
  ESTADO.contadorOrden = ESTADO.cajaActual.contadorOrden;
  DBset('cajaActual', ESTADO.cajaActual);
  return ESTADO.cajaActual.contadorOrden;
}

// Crea un pedido nuevo (tipo: 'mesa'|'llevar'|'domicilio').
function crearPedido(tipo, datos){
  datos = datos || {};
  const venta = {
    id: uid('v'),
    cajaId: ESTADO.cajaActual ? ESTADO.cajaActual.id : null,
    tipo,
    mesa: datos.mesa || null,
    cliente: datos.cliente || null,
    telefono: datos.telefono || null,
    direccion: datos.direccion || null,
    barrio: datos.barrio || null,
    domiciliario: datos.domiciliario || null,
    valorDom: num(datos.valorDom),
    domMetodo: null,
    items: [],                 // [{productoId, nombre, precio, cantidad, obs}]
    obsPedido: datos.obsPedido || '',
    totalComida: 0,
    propina: 0, propinaMetodo: null,
    recargo: 0,
    pagosVenta: {},            // {efectivo, banco, tarjeta} SOLO comida
    pagado: false,
    estado: 'abierta',         // abierta|servida|anulada
    yaFueServida: false,       // marca persistente (error 7)
    ordenCocina: null,
    factura: null,
    copiasComanda: 0,          // reimpresiones de comanda (error 6)
    edicionComanda: 0,         // veces editada (distinto de copias)
    inventarioDescontado: false,
    fecha: ahoraISO(),
    atendio: ESTADO.usuario ? ESTADO.usuario.usuario : null,
    cobro: null,               // {por, fecha}
    nuevosItems: [],           // recuadro "solo lo nuevo" tras servir (error 7)
  };
  if (tipo === 'mesa' || tipo === 'llevar') venta.factura = nuevoNumeroFactura();
  return venta;
}

function recalcularTotalComida(venta){
  venta.totalComida = (venta.items||[]).reduce((s,it)=> s + num(it.precio)*num(it.cantidad), 0);
  return venta.totalComida;
}

// Agrega un producto al pedido. Si la mesa YA fue servida, marca lo nuevo (error 7).
function agregarItem(venta, producto, cantidad, obs){
  cantidad = num(cantidad) || 1;
  const item = {
    lineaId: uid('li'),
    productoId: producto.id, nombre: producto.nombre,
    precio: num(producto.precio), cantidad, obs: obs||'',
    agregadoTrasServir: !!venta.yaFueServida
  };
  venta.items = venta.items || [];
  venta.items.push(item);
  if (venta.yaFueServida){
    venta.nuevosItems = venta.nuevosItems || [];
    venta.nuevosItems.push(item);
    venta.avisarCocinaAgregado = ahoraMs(); // tick para que suene CADA vez (error 7)
    venta.estado = 'abierta';
  }
  recalcularTotalComida(venta);
  return item;
}

/* =======================================================================
   14. COBRO DE PEDIDOS (Parte 3.5) — separa comida/propina/domicilio/recargo
   pago = {
     pagosVenta:{efectivo,banco,tarjeta}, // reparto SOLO de la comida
     propina, propinaMetodo,
     recargo,                             // del datáfono, NO sale del cajón
     valorDom, domMetodo,                 // metodo con que ENTRÓ el domicilio
   }
   ======================================================================= */
function cobrarPedido(venta, pago){
  pago = pago || {};
  recalcularTotalComida(venta);

  const pv = pago.pagosVenta || {};
  const sumaComida = num(pv.efectivo) + num(pv.banco) + num(pv.tarjeta);

  // La comida debe quedar cubierta exactamente (tolerancia de $1 por redondeo).
  if (Math.abs(sumaComida - venta.totalComida) > 1){
    return { error: `El pago de la comida (${pesos(sumaComida)}) no coincide con el total (${pesos(venta.totalComida)}).` };
  }

  venta.pagosVenta = { efectivo:num(pv.efectivo), banco:num(pv.banco), tarjeta:num(pv.tarjeta) };
  venta.propina = num(pago.propina);
  venta.propinaMetodo = pago.propina ? (pago.propinaMetodo || 'efectivo') : null;
  venta.recargo = num(pago.recargo);
  if (venta.tipo === 'domicilio'){
    venta.valorDom = num(pago.valorDom != null ? pago.valorDom : venta.valorDom);
    venta.domMetodo = venta.valorDom ? (pago.domMetodo || 'efectivo') : null;
  }

  // Pagos por banco quedan "por verificar" (Parte 3.5, regla 7).
  venta.porVerificar = (num(pv.banco) > 0);

  venta.pagado = true;
  venta.estado = 'servida';
  venta.yaFueServida = true;         // marca persistente (error 7)
  venta.nuevosItems = [];            // limpiar recuadro de "lo nuevo"
  venta.cobro = { por: ESTADO.usuario && ESTADO.usuario.usuario, fecha: ahoraISO() };

  // Descontar inventario según recetas.
  descontarInventarioPorVenta(venta);

  // Guardar cliente (llevar y domicilio) — error 9.
  if (venta.cliente || venta.telefono){
    guardarCliente({ nombre:venta.cliente, telefono:venta.telefono,
                     direccion:venta.direccion, barrio:venta.barrio });
  }

  fusionarYGuardarVentas(venta);
  return { ok:true };
}

/* =======================================================================
   15. ACCIONES SENSIBLES (Parte 3.6 y 6.5, error 8)
   ======================================================================= */

// Eliminar factura completa (admin/supervisor): descuenta de ventas y efectivo.
// SIN auditoría cuando lo hace admin/supervisor. Devuelve inventario.
function eliminarFactura(venta){
  if (!puede('eliminarFactura')) { alert('No tienes permiso.'); return false; }
  devolverInventarioPorVenta(venta);            // devolver materia prima
  borrarVentaSegura(venta.id);                  // sale de ventas -> baja efectivo esperado (recalcula en vivo)
  // SIN auditoría (regla explícita para admin/supervisor).
  return true;
}

// Quitar un producto de una factura: recalcula total y REAJUSTA pagos proporcional.
function quitarProducto(venta, lineaId){
  if (!puede('quitarProducto')) { alert('No tienes permiso.'); return false; }
  const idx = (venta.items||[]).findIndex(it => it.lineaId === lineaId);
  if (idx < 0) return false;

  const totalAntes = recalcularTotalComida(venta);
  const item = venta.items[idx];

  // Devolver inventario del item quitado (si ya se había descontado).
  if (venta.inventarioDescontado){
    const receta = (CACHE.recetas||{})[item.productoId];
    if (receta) receta.forEach(r =>
      movimientoInsumo(r.insumoId, +num(r.cantidad)*num(item.cantidad),
        'Quitar producto '+(venta.factura||venta.id), 'devolucion'));
  }

  venta.items.splice(idx, 1);
  const totalDespues = recalcularTotalComida(venta);

  // Reajuste proporcional de los pagos de comida (sin valores fantasma).
  if (venta.pagado && totalAntes > 0){
    const factor = totalDespues / totalAntes;
    const pv = venta.pagosVenta || {};
    venta.pagosVenta = {
      efectivo: Math.round(num(pv.efectivo)*factor),
      banco:    Math.round(num(pv.banco)*factor),
      tarjeta:  Math.round(num(pv.tarjeta)*factor),
    };
    // Corregir redondeo para que sume exacto al nuevo total.
    ajustarRedondeoPagos(venta);
  }
  fusionarYGuardarVentas(venta);
  // SIN auditoría (regla admin/supervisor).
  return true;
}

// Ajusta el reparto para que efectivo+banco+tarjeta == totalComida exacto.
function ajustarRedondeoPagos(venta){
  const pv = venta.pagosVenta || {};
  let suma = num(pv.efectivo)+num(pv.banco)+num(pv.tarjeta);
  const dif = venta.totalComida - suma;
  if (dif !== 0){
    // Ajusta sobre el método con mayor monto.
    const orden = ['efectivo','banco','tarjeta'].sort((a,b)=>num(pv[b])-num(pv[a]));
    pv[orden[0]] = num(pv[orden[0]]) + dif;
  }
  venta.pagosVenta = pv;
}

// Editar forma de pago tras cobrado (admin/supervisor/cajero) -> SÍ auditoría.
function editarFormaPago(venta, nuevoPagosVenta){
  if (!puede('editarPago')) { alert('No tienes permiso.'); return false; }
  const antes = JSON.stringify(venta.pagosVenta);
  const pv = nuevoPagosVenta || {};
  const suma = num(pv.efectivo)+num(pv.banco)+num(pv.tarjeta);
  if (Math.abs(suma - venta.totalComida) > 1){
    alert('El nuevo reparto no cubre el total de la comida.'); return false;
  }
  venta.pagosVenta = { efectivo:num(pv.efectivo), banco:num(pv.banco), tarjeta:num(pv.tarjeta) };
  venta.porVerificar = (num(pv.banco) > 0);
  fusionarYGuardarVentas(venta);
  registrarAuditoria('EDITAR_PAGO',
    `${venta.factura||venta.cliente||venta.id}: ${antes} -> ${JSON.stringify(venta.pagosVenta)}`);
  return true;
}

// Anular pedido. Mesa/llevar: quedan "anulada" con rastro. Domicilio: admin borra sin rastro.
function anularPedido(venta){
  if (!puede('anularPedido')) { alert('No tienes permiso.'); return false; }
  devolverInventarioPorVenta(venta);
  if (venta.tipo === 'domicilio' && ESTADO.usuario.rol === 'admin'){
    borrarVentaSegura(venta.id); // domicilio: sin rastro (solo admin)
  } else {
    venta.estado = 'anulada';
    venta.anuladaPor = ESTADO.usuario && ESTADO.usuario.usuario;
    venta.fechaAnulacion = ahoraISO();
    fusionarYGuardarVentas(venta);
  }
  registrarAuditoria('ANULAR_PEDIDO', venta.factura||venta.cliente||venta.id);
  return true;
}

// Marcar como servido/entregado (mesero/cajero). Activa yaFueServida.
function marcarServido(venta){
  venta.estado = 'servida';
  venta.yaFueServida = true;
  venta.nuevosItems = [];
  fusionarYGuardarVentas(venta);
}

/* =======================================================================
   16. SONIDOS (Web Audio API) — pedido nuevo, llamado mesero
   ======================================================================= */
let _audioCtx = null;
function audioCtx(){
  if (!_audioCtx){
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e){ return null; }
  }
  return _audioCtx;
}
function beep(freq, durMs, vol){
  const ctx = audioCtx(); if (!ctx) return;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = 'square'; osc.frequency.value = freq;
  g.gain.value = vol != null ? vol : 0.25;
  osc.connect(g); g.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durMs/1000);
}
// Sonido fuerte y repetido para pedido nuevo en cocina.
function sonidoPedidoNuevo(){
  beep(880, 180, 0.35);
  setTimeout(()=>beep(1180,180,0.35), 220);
  setTimeout(()=>beep(880, 220,0.35), 460);
}
// Sonido de llamado a mesero (más insistente).
function sonidoLlamarMesero(){
  for (let i=0;i<3;i++) setTimeout(()=>{ beep(1320,150,0.4); setTimeout(()=>beep(990,150,0.4),170); }, i*400);
}

/* =======================================================================
   17. KDS — PANTALLA DE COCINA (Parte 3.3)
   ======================================================================= */
// Estados de cocina por venta: 'pendiente' | 'preparando' | 'listo'
function pedidosParaCocina(){
  // Solo de la caja actual y no cobrados-anulados; con items.
  const cajaId = ESTADO.cajaActual ? ESTADO.cajaActual.id : null;
  return ventasArray().filter(v =>
    v.cajaId === cajaId &&
    v.estado !== 'anulada' &&
    (v.items||[]).length > 0 &&
    v.cocinaEstado !== 'listo_entregado'
  ).sort((a,b)=> new Date(a.fecha) - new Date(b.fecha));
}
function colorTemporizador(min){
  if (min < 8) return 'verde';
  if (min < 15) return 'amarillo';
  return 'rojo';
}
function cocinaMarcar(venta, estado){
  venta.cocinaEstado = estado; // 'preparando'|'listo'
  if (estado === 'listo') venta.horaListo = ahoraISO();
  fusionarYGuardarVentas(venta);
}
// Llamar mesero: tick ÚNICO por pulsación (error 3 KDS), suena en mesero y cocina.
function llamarMesero(venta){
  const tick = ahoraMs() + '_' + Math.random().toString(36).slice(2,6);
  const reg = { tick, mesa: venta.mesa || venta.cliente || venta.factura, fecha: ahoraISO() };
  DBset('llamadoMesero', reg);  // se propaga a todos los dispositivos
  sonidoLlamarMesero();
}

/* =======================================================================
   18. IMPRESIÓN (Parte 3.4)
   ======================================================================= */
function ventanaImpresion(html, titulo){
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w){ alert('Habilita las ventanas emergentes para imprimir.'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${titulo||''}</title>
    <style>
      @page { margin: 4mm; }
      body{ font-family:'Inter',Arial,sans-serif; color:#000; margin:0; padding:6px; }
      .center{text-align:center} .b{font-weight:bold} .big{font-size:20px}
      .xbig{font-size:26px;font-weight:bold}
      .line{border-top:1px dashed #000;margin:6px 0}
      table{width:100%;border-collapse:collapse;font-size:13px}
      td{padding:2px 0;vertical-align:top}
      .right{text-align:right}
      .marca{position:fixed;top:38%;left:0;right:0;text-align:center;
             font-size:60px;color:rgba(0,0,0,0.06);transform:rotate(-20deg);z-index:0}
      .content{position:relative;z-index:1}
      .copia{border:2px solid #000;display:inline-block;padding:2px 8px;font-weight:bold;margin-top:4px}
      .nuevo{border:2px solid #000;padding:4px;margin-top:6px;color:#000;font-weight:bold}
      .grande{font-size:22px;line-height:1.5}
    </style></head><body onload="window.print();setTimeout(()=>window.close(),400)">
    ${html}</body></html>`);
  w.document.close();
}

// COMANDA DE COCINA: sin precios, letra grande. Muestra copia si es reimpresión.
function imprimirComanda(venta, esReimpresion){
  if (esReimpresion){ venta.copiasComanda = (venta.copiasComanda||0)+1; fusionarYGuardarVentas(venta); }
  const dest = venta.tipo==='mesa' ? ('MESA '+venta.mesa)
             : venta.tipo==='llevar' ? 'PARA LLEVAR'
             : ('DOMICILIO'+(venta.barrio?(' · '+venta.barrio):''));
  let filas = (venta.items||[]).map(it =>
    `<tr><td class="grande b">${it.cantidad}x</td><td class="grande">${it.nombre}${it.obs?('<br><small>› '+it.obs+'</small>'):''}</td></tr>`
  ).join('');
  // Recuadro de "solo lo nuevo" si agregaron tras servir (error 7): letra negra con borde.
  let nuevoBox = '';
  if (venta.nuevosItems && venta.nuevosItems.length){
    const nuevas = venta.nuevosItems.map(it=>`${it.cantidad}x ${it.nombre}${it.obs?(' ('+it.obs+')'):''}`).join('<br>');
    nuevoBox = `<div class="nuevo">★ AGREGARON PEDIDO:<br>${nuevas}</div>`;
  }
  const copia = (venta.copiasComanda>0) ? `<div class="center"><span class="copia">COPIA ${venta.copiasComanda}</span></div>` : '';
  const html = `<div class="content">
    <div class="center xbig">ORDEN #${String(venta.ordenCocina||0).padStart(3,'0')}</div>
    <div class="center big b">${dest}</div>
    <div class="center">${fmtHora(venta.fecha)}</div>
    <div class="line"></div>
    <table>${filas}</table>
    ${venta.obsPedido?('<div class="line"></div><div class="grande">Obs: '+venta.obsPedido+'</div>'):''}
    ${nuevoBox}
    <div class="line"></div>
    <div class="center">Atendió: ${venta.atendio||''}</div>
    ${copia}
  </div>`;
  ventanaImpresion(html, 'Comanda #'+venta.ordenCocina);
}

// FACTURA DEL CLIENTE: elegante, con logo, desglose, marca de agua, correo al pie.
function imprimirFactura(venta){
  const logo = window.LOGO_DEFAULT || '';
  let filas = (venta.items||[]).map(it =>
    `<tr><td>${it.cantidad}x ${it.nombre}</td><td class="right">${pesos(it.precio*it.cantidad)}</td></tr>`
  ).join('');
  const subtotal = venta.totalComida;
  const total = subtotal + num(venta.valorDom) + num(venta.propina) + num(venta.recargo);
  const pv = venta.pagosVenta || {};
  let metodos = [];
  if (num(pv.efectivo)) metodos.push('Efectivo '+pesos(pv.efectivo));
  if (num(pv.banco))    metodos.push('Banco '+pesos(pv.banco));
  if (num(pv.tarjeta))  metodos.push('Tarjeta '+pesos(pv.tarjeta));

  const html = `<div class="marca">${NEGOCIO.nombre.toUpperCase()}</div>
  <div class="content">
    <div class="center">${logo?`<img src="${logo}" style="max-width:150px;max-height:90px">`:''}</div>
    <div class="center b big">${NEGOCIO.nombre}</div>
    <div class="center"><small>${NEGOCIO.rubro} · ${NEGOCIO.ciudad}</small></div>
    <div class="center"><small>${NEGOCIO.direccion} · Tel ${NEGOCIO.telefono}</small></div>
    <div class="line"></div>
    <div>${venta.factura?('Factura: '+venta.factura):('Cliente: '+(venta.cliente||''))}</div>
    <div>${fmtFechaHora(venta.fecha)}</div>
    ${venta.tipo==='mesa'?('<div>Mesa: '+venta.mesa+'</div>'):''}
    ${venta.tipo==='domicilio'?(`<div>Cliente: ${venta.cliente||''}<br>Tel: ${venta.telefono||''}<br>Dir: ${venta.direccion||''} (${venta.barrio||''})</div>`):''}
    <div class="line"></div>
    <table>${filas}</table>
    <div class="line"></div>
    <table>
      <tr><td>Subtotal</td><td class="right">${pesos(subtotal)}</td></tr>
      ${num(venta.valorDom)?`<tr><td>Domicilio</td><td class="right">${pesos(venta.valorDom)}</td></tr>`:''}
      ${num(venta.propina)?`<tr><td>Propina</td><td class="right">${pesos(venta.propina)}</td></tr>`:''}
      ${num(venta.recargo)?`<tr><td>Recargo datáfono</td><td class="right">${pesos(venta.recargo)}</td></tr>`:''}
      <tr><td class="b big">TOTAL</td><td class="right b big">${pesos(total)}</td></tr>
    </table>
    <div class="line"></div>
    <div><small>Pago: ${metodos.join(' · ')||'-'}</small></div>
    <div><small>Atendió: ${venta.atendio||''} · Cobró: ${(venta.cobro&&venta.cobro.por)||''}</small></div>
    <div class="line"></div>
    <div class="center"><small>${NEGOCIO.correo}</small></div>
    <div class="center"><small>¡Gracias por su compra!</small></div>
  </div>`;
  ventanaImpresion(html, 'Factura '+(venta.factura||venta.cliente||''));
}

// FACTURA DEL CIERRE DE CAJA: letra grande y negrilla, resultado destacado.
function imprimirCierre(cierre){
  const r = cierre;
  const html = `<div class="content">
    <div class="center xbig">CIERRE DE CAJA</div>
    <div class="center b">${NEGOCIO.nombre}</div>
    <div class="center">${fmtFechaHora(r.fechaCierre)}</div>
    <div class="center">Cajero: ${r.cajero||''}</div>
    <div class="line"></div>
    <table class="grande">
      <tr><td class="b">Base inicial</td><td class="right b">${pesos(r.base)}</td></tr>
      <tr><td class="b">Ventas (comida)</td><td class="right b">${pesos(r.totalVentas)}</td></tr>
      <tr><td>› Efectivo</td><td class="right">${pesos(r.porMetodo.efectivo)}</td></tr>
      <tr><td>› Banco</td><td class="right">${pesos(r.porMetodo.banco)}</td></tr>
      <tr><td>› Tarjeta</td><td class="right">${pesos(r.porMetodo.tarjeta)}</td></tr>
      <tr><td>Propinas</td><td class="right">${pesos(r.propinas)}</td></tr>
      <tr><td>Domicilios</td><td class="right">${pesos(r.domicilios)}</td></tr>
      <tr><td>Recargos</td><td class="right">${pesos(r.recargos)}</td></tr>
    </table>
    <div class="line"></div>
    <table class="grande">
      <tr><td class="b">EFECTIVO ESPERADO</td><td class="right b">${pesos(r.esperado)}</td></tr>
      <tr><td class="b">EFECTIVO CONTADO</td><td class="right b">${pesos(r.contado)}</td></tr>
      <tr><td class="xbig">${r.resultado}</td><td class="right xbig">${pesos(r.diferencia)}</td></tr>
    </table>
    <div class="line"></div>
    <div class="center"><small>${NEGOCIO.correo}</small></div>
  </div>`;
  ventanaImpresion(html, 'Cierre de caja');
}

/* =======================================================================
   19. REPORTES Y DASHBOARD (Parte 3.7)
   ======================================================================= */
function resumenJornada(){
  const vs = ventasCajaActual().filter(v=>v.pagado);
  const t = { totalVendido:0, numVentas:vs.length, porMetodo:{efectivo:0,banco:0,tarjeta:0},
              propinasPorMesero:{}, platos:{}, domicilios:0, recargos:0 };
  vs.forEach(v=>{
    t.totalVendido += num(v.totalComida);
    const pv=v.pagosVenta||{};
    t.porMetodo.efectivo+=num(pv.efectivo); t.porMetodo.banco+=num(pv.banco); t.porMetodo.tarjeta+=num(pv.tarjeta);
    if (v.propina){ const m=v.atendio||'?'; t.propinasPorMesero[m]=(t.propinasPorMesero[m]||0)+num(v.propina); }
    t.domicilios+=num(v.valorDom); t.recargos+=num(v.recargo);
    (v.items||[]).forEach(it=>{ t.platos[it.nombre]=(t.platos[it.nombre]||0)+num(it.cantidad); });
  });
  t.topPlatos = Object.entries(t.platos).sort((a,b)=>b[1]-a[1]).slice(0,10);
  return t;
}
function ventasUltimos7Dias(){
  const hoyClave = diaLocalClave(ahoraISO());
  const mapa = {};
  ventasArray().filter(v=>v.pagado && v.estado!=='anulada').forEach(v=>{
    const k = diaLocalClave(v.fecha);
    mapa[k] = (mapa[k]||0) + num(v.totalComida);
  });
  const dias = [];
  for (let i=6;i>=0;i--){
    const ms = ahoraMs() - i*86400000;
    const k = diaLocalClave(new Date(ms).toISOString());
    dias.push({ dia:k, total: mapa[k]||0 });
  }
  return dias;
}
function tiempoPromedioEntrega(){
  const vs = ventasCajaActual().filter(v=>v.horaListo);
  if (!vs.length) return 0;
  const suma = vs.reduce((s,v)=> s + (new Date(v.horaListo)-new Date(v.fecha)), 0);
  return Math.round(suma / vs.length / 60000); // minutos
}

/* =======================================================================
   20. RESPALDO — exportar a JSON (Parte 3.7)
   ======================================================================= */
function exportarJSON(){
  const data = {
    exportado: ahoraISO(),
    negocio: NEGOCIO.nombre,
    ventas: ventasObj(),
    cajaActual: CACHE.cajaActual,
    historialCierres: CACHE.historialCierres,
    insumos: CACHE.insumos, recetas: CACHE.recetas,
    menu: CACHE.menu, clientes: CACHE.clientes,
    usuarios: CACHE.usuarios, auditoria: CACHE.auditoria,
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'respaldo_portal_imperial_'+diaLocalClave(ahoraISO())+'.json';
  a.click();
}

/* =======================================================================
   21. LOGIN Y SESIÓN (Parte 3.1)
   ======================================================================= */
function login(usuario, clave){
  const us = CACHE.usuarios || {};
  const encontrado = Object.values(us).find(u =>
    u.usuario === usuario && u.clave === clave);
  if (!encontrado){ return false; }
  ESTADO.usuario = encontrado;
  registrarAuditoria('LOGIN', 'Ingreso de ' + usuario);
  reiniciarInactividad();
  return true;
}
function logout(){
  if (ESTADO.usuario) registrarAuditoria('LOGOUT', ESTADO.usuario.usuario);
  ESTADO.usuario = null;
  ESTADO.vista = 'login';
  render();
}

// Bloqueo de pantalla (F8) y cierre por inactividad (30 min).
let _inactTimer = null;
function reiniciarInactividad(){
  if (_inactTimer) clearTimeout(_inactTimer);
  _inactTimer = setTimeout(()=>{ if (ESTADO.usuario){ logout(); alert('Sesión cerrada por inactividad.'); } }, 30*60*1000);
}
function bloquearPantalla(){ ESTADO.bloqueado = true; render(); }
function desbloquearPantalla(clave){
  if (ESTADO.usuario && ESTADO.usuario.clave === clave){ ESTADO.bloqueado=false; render(); return true; }
  return false;
}
document.addEventListener('keydown', e=>{ if (e.key==='F8' && ESTADO.usuario){ e.preventDefault(); bloquearPantalla(); }});
['click','keydown','mousemove','touchstart'].forEach(ev=>
  document.addEventListener(ev, ()=>{ if (ESTADO.usuario) reiniciarInactividad(); }, {passive:true}));

/* =======================================================================
   22. ARRANQUE DEL SISTEMA
   ======================================================================= */
let _ultimoLlamadoTick = null;
let _ticksVentasVistos = {};

function arrancar(){
  lsCargar();
  initFirebase();
  inicializarDatos();

  // Suscripciones en tiempo real.
  suscribirVentas(arr => { ESTADO.ventas = arr; detectarAvisosCocina(arr); if (ESTADO.usuario) render(); });
  DBon('cajaActual', c => { ESTADO.cajaActual = c; if (ESTADO.usuario) render(); });
  DBon('menu', m => { if (m) ESTADO.menu = m; });
  DBon('insumos', i => { if (i) ESTADO.insumos = i; });
  DBon('recetas', r => { if (r) ESTADO.recetas = r; });
  DBon('clientes', c => { if (c) ESTADO.clientes = c; });
  DBon('usuarios', u => { if (u) ESTADO.usuarios = u; });
  DBon('llamadoMesero', reg => {
    if (reg && reg.tick && reg.tick !== _ultimoLlamadoTick){
      _ultimoLlamadoTick = reg.tick;
      // Suena en la pantalla del mesero (y cocina). Solo si hay sesión.
      if (ESTADO.usuario && ['mesero','admin','supervisor','jefe','cocina'].includes(ESTADO.usuario.rol)){
        sonidoLlamarMesero();
        mostrarToast('🔔 Cocina llama: ' + (reg.mesa||''));
      }
    }
  });

  render();
  setInterval(()=>{ if (ESTADO.usuario && (ESTADO.vista==='cocina'||ESTADO.vista==='dashboard')) render(); }, 5000);
}

// Detecta pedidos nuevos / agregados para sonar en cocina (error 7).
function detectarAvisosCocina(arr){
  if (!(ESTADO.usuario && ['cocina','admin','supervisor'].includes(ESTADO.usuario.rol))) return;
  arr.forEach(v=>{
    // Pedido nuevo
    if (v.ordenCocina && !_ticksVentasVistos['n_'+v.id]){
      _ticksVentasVistos['n_'+v.id] = true;
      if (segundosDesde(v.fecha) < 30) sonidoPedidoNuevo();
    }
    // Agregado tras servir (tick único cada vez)
    if (v.avisarCocinaAgregado && _ticksVentasVistos['a_'+v.id] !== v.avisarCocinaAgregado){
      _ticksVentasVistos['a_'+v.id] = v.avisarCocinaAgregado;
      sonidoPedidoNuevo();
      mostrarToast('★ Agregaron a '+(v.mesa?('mesa '+v.mesa):(v.cliente||v.factura)));
    }
  });
}

/* =======================================================================
   23. INTERFAZ (RENDER) — utilidades de UI
   ======================================================================= */
function $(sel){ return document.querySelector(sel); }
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function mostrarToast(msg){
  let t = el('toast');
  if (!t){ t=document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._to); t._to = setTimeout(()=>t.classList.remove('show'), 3500);
}
function modal(html){
  let m = el('modal');
  if (!m){ m=document.createElement('div'); m.id='modal'; m.className='modal-bg'; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal-card">${html}</div>`;
  m.classList.add('show');
  m.onclick = e=>{ if (e.target===m) cerrarModal(); };
}
function cerrarModal(){ const m=el('modal'); if (m) m.classList.remove('show'); }

/* =======================================================================
   24. RENDER PRINCIPAL — decide qué vista mostrar
   ======================================================================= */
function render(){
  const app = el('app');
  if (!app) return;

  if (!ESTADO.usuario){ app.innerHTML = vistaLogin(); enlazarLogin(); return; }
  if (ESTADO.bloqueado){ app.innerHTML = vistaBloqueo(); enlazarBloqueo(); return; }

  app.innerHTML = layout(cuerpoVista());
  enlazarNav();
  enlazarVista();
}

function layout(cuerpo){
  const u = ESTADO.usuario;
  const caja = ESTADO.cajaActual;
  const nav = itemsNav().map(i=>
    `<button class="nav-item ${ESTADO.vista===i.id?'activo':''}" data-vista="${i.id}">
       <span class="nav-ico">${i.ico}</span><span>${i.txt}</span>
     </button>`).join('');
  const alertas = insumosBajoMinimo().length;
  return `
  <div class="topbar">
    <div class="brand">
      <img src="${window.LOGO_DEFAULT||''}" class="brand-logo" alt="logo">
      <div><div class="brand-name">${NEGOCIO.nombre}</div>
      <div class="brand-sub">${NEGOCIO.rubro}</div></div>
    </div>
    <div class="topbar-info">
      <span class="reloj" id="reloj">${fmtHora(ahoraISO())}</span>
      <span class="caja-estado ${caja?'abierta':'cerrada'}">${caja?('Caja abierta · '+pesos(calcularEfectivoEsperado())):'Caja cerrada'}</span>
      ${alertas?`<span class="badge-alerta">⚠ ${alertas} insumo(s)</span>`:''}
      <span class="user-chip">${esc(u.nombre)} · ${u.rol}</span>
      <button class="btn-mini" onclick="bloquearPantalla()">🔒 F8</button>
      <button class="btn-mini" onclick="logout()">Salir</button>
    </div>
  </div>
  <div class="main">
    <nav class="sidebar">${nav}</nav>
    <section class="content-area">${cuerpo}</section>
  </div>`;
}

function itemsNav(){
  const items = [];
  if (puede('tomarPedido'))   items.push({id:'pedidos', ico:'🍽️', txt:'Pedidos'});
  if (puede('verCocina'))     items.push({id:'cocina', ico:'👨‍🍳', txt:'Cocina'});
  if (puede('cobrar')||puede('abrirCaja')) items.push({id:'caja', ico:'💵', txt:'Caja'});
  if (puede('verDashboard'))  items.push({id:'dashboard', ico:'📊', txt:'Dashboard'});
  if (puede('verReportes'))   items.push({id:'reportes', ico:'📈', txt:'Reportes'});
  if (puede('verInventario')) items.push({id:'inventario', ico:'📦', txt:'Inventario'});
  if (puede('verAuditoria'))  items.push({id:'auditoria', ico:'🕵️', txt:'Auditoría'});
  if (puede('gestionUsuarios')) items.push({id:'config', ico:'⚙️', txt:'Configuración'});
  return items;
}

function cuerpoVista(){
  // Si la vista actual no está permitida, cae a la primera disponible.
  const permitidas = itemsNav().map(i=>i.id);
  if (!permitidas.includes(ESTADO.vista)) ESTADO.vista = permitidas[0] || 'pedidos';
  switch(ESTADO.vista){
    case 'pedidos':   return vistaPedidos();
    case 'cocina':    return vistaCocina();
    case 'caja':      return vistaCaja();
    case 'dashboard': return vistaDashboard();
    case 'reportes':  return vistaReportes();
    case 'inventario':return vistaInventario();
    case 'auditoria': return vistaAuditoria();
    case 'config':    return vistaConfig();
    default:          return vistaPedidos();
  }
}
function enlazarNav(){
  document.querySelectorAll('.nav-item').forEach(b=>
    b.onclick = ()=>{ ESTADO.vista = b.dataset.vista; render(); });
}
// Reloj en vivo
setInterval(()=>{ const r=el('reloj'); if (r) r.textContent = fmtHora(ahoraISO()); }, 1000);

/* =======================================================================
   25. VISTA LOGIN
   ======================================================================= */
function vistaLogin(){
  return `<div class="login-wrap">
    <div class="login-card">
      <img src="${window.LOGO_DEFAULT||''}" class="login-logo" alt="logo">
      <h1>${NEGOCIO.nombre}</h1>
      <p class="login-sub">${NEGOCIO.rubro} · ${NEGOCIO.ciudad}</p>
      <input id="loginUser" class="inp" placeholder="Usuario" autocomplete="username">
      <input id="loginPass" class="inp" type="password" placeholder="Contraseña" autocomplete="current-password">
      <button id="loginBtn" class="btn-primary btn-block">Ingresar</button>
      <div id="loginError" class="login-error"></div>
      <div class="login-demo">Demo: admin / admin123 · cajero / caja123 · mesero / mesa123 · cocina / coci123</div>
      <div class="login-foot">WALLACE COMPANY SYSTEM<br>${NEGOCIO.correo}</div>
    </div>
  </div>`;
}
function enlazarLogin(){
  const go = ()=>{
    const u = el('loginUser').value.trim(), p = el('loginPass').value;
    if (login(u,p)){ ESTADO.vista = itemsNav()[0]?.id || 'pedidos'; render(); }
    else { el('loginError').textContent = 'Usuario o contraseña incorrectos.'; }
  };
  el('loginBtn').onclick = go;
  el('loginPass').onkeydown = e=>{ if (e.key==='Enter') go(); };
  el('loginUser').onkeydown = e=>{ if (e.key==='Enter') el('loginPass').focus(); };
}
function vistaBloqueo(){
  return `<div class="login-wrap"><div class="login-card">
    <div style="font-size:52px">🔒</div>
    <h1>Pantalla bloqueada</h1>
    <p class="login-sub">${esc(ESTADO.usuario.nombre)}</p>
    <input id="unlockPass" class="inp" type="password" placeholder="Contraseña para desbloquear">
    <button id="unlockBtn" class="btn-primary btn-block">Desbloquear</button>
    <div id="unlockError" class="login-error"></div>
  </div></div>`;
}
function enlazarBloqueo(){
  const go = ()=>{ if (!desbloquearPantalla(el('unlockPass').value)) el('unlockError').textContent='Clave incorrecta.'; };
  el('unlockBtn').onclick = go;
  el('unlockPass').onkeydown = e=>{ if (e.key==='Enter') go(); };
}

/* =======================================================================
   26. VISTA PEDIDOS
   ======================================================================= */
function pedidoActivoDeMesa(mesa){
  return ventasArray().find(v => v.tipo==='mesa' && v.mesa===mesa &&
    v.estado!=='anulada' && !v.pagado);
}
function vistaPedidos(){
  if (!ESTADO.cajaActual){
    return `<div class="aviso-caja">
      <h2>⚠ No hay caja abierta</h2>
      <p>Para tomar pedidos primero se debe abrir la caja.</p>
      ${puede('abrirCaja')?'<button class="btn-primary" onclick="ESTADO.vista=\'caja\';render()">Ir a Caja</button>':''}
    </div>`;
  }
  const p = ESTADO.pedidoEnCurso;
  if (p) return vistaPedidoEnCurso(p);

  // Selector de tipo + mesas
  const mesas = [];
  for (let i=1;i<=NEGOCIO.numMesas;i++){
    const ocupada = pedidoActivoDeMesa(i);
    mesas.push(`<button class="mesa ${ocupada?'ocupada':'libre'}" data-mesa="${i}">
      <span class="mesa-n">Mesa ${i}</span>
      <span class="mesa-st">${ocupada?pesos(ocupada.totalComida):'Libre'}</span>
    </button>`);
  }
  return `<div class="vista-pedidos">
    <div class="tipo-pedido">
      <button class="btn-tipo" data-tipo="llevar">🥡 Para llevar</button>
      <button class="btn-tipo" data-tipo="domicilio">🛵 Domicilio</button>
    </div>
    <h3 class="sec-title">Mesas</h3>
    <div class="mesas-grid">${mesas.join('')}</div>
  </div>`;
}

function abrirNuevoPedido(tipo, mesa){
  let venta;
  if (tipo==='mesa'){
    venta = pedidoActivoDeMesa(mesa) || crearPedido('mesa', {mesa});
  } else {
    venta = crearPedido(tipo, {});
  }
  ESTADO.pedidoEnCurso = venta;
  render();
}

function vistaPedidoEnCurso(v){
  const cats = Object.keys(ESTADO.menu||{});
  const catActiva = ESTADO._catActiva || cats[0];
  const productos = (ESTADO.menu[catActiva]||[]).map(pr=>
    `<button class="prod ${pr.agotado?'agotado':''}" data-prod="${pr.id}" ${pr.agotado?'disabled':''}>
       <span class="prod-n">${esc(pr.nombre)}</span>
       <span class="prod-p">${pesos(pr.precio)}</span>
       ${pr.agotado?'<span class="prod-ag">AGOTADO</span>':''}
     </button>`).join('');
  const tabs = cats.map(c=>`<button class="cat-tab ${c===catActiva?'activo':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');

  const items = (v.items||[]).map(it=>
    `<div class="linea-item">
       <span class="li-cant">${it.cantidad}x</span>
       <span class="li-nom">${esc(it.nombre)}${it.obs?`<br><small>› ${esc(it.obs)}</small>`:''}</span>
       <span class="li-sub">${pesos(it.precio*it.cantidad)}</span>
       <button class="li-del" data-linea="${it.lineaId}">✕</button>
     </div>`).join('') || '<div class="vacio">Sin productos aún</div>';

  const esDom = v.tipo==='domicilio';
  const titulo = v.tipo==='mesa'?('Mesa '+v.mesa) : v.tipo==='llevar'?('Para llevar'+(v.factura?(' · '+v.factura):'')) : 'Domicilio';

  return `<div class="pedido-layout">
    <div class="menu-col">
      <div class="cat-tabs">${tabs}</div>
      <input id="buscarProd" class="inp" placeholder="Buscar producto...">
      <div class="prod-grid" id="prodGrid">${productos}</div>
    </div>
    <div class="ticket-col">
      <div class="ticket-head">
        <h3>${titulo}</h3>
        <button class="btn-mini" onclick="ESTADO.pedidoEnCurso=null;ESTADO._catActiva=null;render()">← Volver</button>
      </div>
      ${esDom?vistaCamposDomicilio(v):(v.tipo==='llevar'?vistaCamposLlevar(v):'')}
      <div class="ticket-items">${items}</div>
      <div class="ticket-obs">
        <input id="obsPedido" class="inp" placeholder="Observación general del pedido" value="${esc(v.obsPedido||'')}">
      </div>
      <div class="ticket-total">
        <span>Total comida</span><span class="tt-val">${pesos(v.totalComida)}</span>
      </div>
      <div class="ticket-acciones">
        <button class="btn-secondary" id="btnGuardarEnviar">💾 Guardar / Enviar a cocina</button>
        ${puede('cobrar')?`<button class="btn-primary" id="btnCobrar" ${v.items.length?'':'disabled'}>💵 Cobrar</button>`:''}
      </div>
      ${v.yaFueServida?'<div class="chip-servida">✔ Mesa ya servida — lo nuevo se marcará para cocina</div>':''}
    </div>
  </div>`;
}

function vistaCamposLlevar(v){
  return `<div class="campos-cliente">
    <div class="cli-row">
      <input id="cliNombre" class="inp" placeholder="Nombre cliente" value="${esc(v.cliente||'')}" autocomplete="off">
      <input id="cliTel" class="inp" placeholder="Teléfono" value="${esc(v.telefono||'')}" autocomplete="off">
    </div>
    <div id="sugerencias" class="sugerencias"></div>
  </div>`;
}
function vistaCamposDomicilio(v){
  const doms = (ESTADO.domiciliarios||[]).map(d=>`<option ${v.domiciliario===d?'selected':''}>${esc(d)}</option>`).join('');
  return `<div class="campos-cliente">
    <div class="cli-row">
      <input id="cliNombre" class="inp" placeholder="Nombre cliente" value="${esc(v.cliente||'')}" autocomplete="off">
      <input id="cliTel" class="inp" placeholder="Teléfono" value="${esc(v.telefono||'')}" autocomplete="off">
    </div>
    <div id="sugerencias" class="sugerencias"></div>
    <div class="cli-row">
      <input id="cliDir" class="inp" placeholder="Dirección" value="${esc(v.direccion||'')}">
      <input id="cliBarrio" class="inp" placeholder="Barrio" value="${esc(v.barrio||'')}">
    </div>
    <div class="cli-row">
      <select id="cliDom" class="inp"><option value="">Domiciliario...</option>${doms}</select>
      <input id="valorDom" class="inp" placeholder="Valor domicilio" value="${v.valorDom||''}" inputmode="numeric">
    </div>
  </div>`;
}

/* =======================================================================
   27. ENLACES DE VISTA (despacho por vista)
   ======================================================================= */
function enlazarVista(){
  switch(ESTADO.vista){
    case 'pedidos':   enlazarPedidos(); break;
    case 'cocina':    enlazarCocina(); break;
    case 'caja':      enlazarCaja(); break;
    case 'inventario':enlazarInventario(); break;
    case 'config':    enlazarConfig(); break;
    case 'reportes':  enlazarReportes(); break;
  }
}

function enlazarPedidos(){
  // Selector de tipo
  document.querySelectorAll('.btn-tipo').forEach(b=>
    b.onclick = ()=> abrirNuevoPedido(b.dataset.tipo));
  // Mesas
  document.querySelectorAll('.mesa').forEach(b=>
    b.onclick = ()=> abrirNuevoPedido('mesa', num(b.dataset.mesa)));

  const v = ESTADO.pedidoEnCurso;
  if (!v) return;

  // Tabs de categoría
  document.querySelectorAll('.cat-tab').forEach(b=>
    b.onclick = ()=>{ ESTADO._catActiva = b.dataset.cat; render(); });

  // Agregar producto
  document.querySelectorAll('.prod').forEach(b=>{
    if (b.disabled) return;
    b.onclick = ()=>{
      const cats = ESTADO.menu||{};
      let prod=null;
      Object.values(cats).forEach(arr=>{ const f=arr.find(p=>p.id===b.dataset.prod); if(f) prod=f; });
      if (!prod) return;
      pedirCantidadYObs(prod, (cant,obs)=>{
        agregarItem(v, prod, cant, obs);
        fusionarYGuardarVentas(v); // persistir mientras se arma
        render();
      });
    };
  });

  // Buscar producto
  const buscar = el('buscarProd');
  if (buscar) buscar.oninput = ()=>{
    const t = buscar.value.toLowerCase();
    document.querySelectorAll('.prod').forEach(b=>{
      const nom = b.querySelector('.prod-n').textContent.toLowerCase();
      b.style.display = nom.includes(t) ? '' : 'none';
    });
  };

  // Quitar línea (antes de cobrar: libre; después: requiere permiso vía quitarProducto)
  document.querySelectorAll('.li-del').forEach(b=>
    b.onclick = ()=>{
      const lineaId = b.dataset.linea;
      if (v.pagado){
        if (quitarProducto(v, lineaId)) render();
      } else {
        v.items = v.items.filter(it=>it.lineaId!==lineaId);
        recalcularTotalComida(v);
        fusionarYGuardarVentas(v);
        render();
      }
    });

  // Campos cliente + sugerencias (NO autorrelleno — error 9)
  ['cliNombre','cliTel'].forEach(id=>{
    const inp = el(id);
    if (!inp) return;
    inp.oninput = ()=>{
      // Guardar lo escrito en el pedido en curso
      if (id==='cliNombre') v.cliente = inp.value;
      if (id==='cliTel') v.telefono = inp.value;
      mostrarSugerencias(inp.value);
    };
  });
  ['cliDir','cliBarrio','valorDom'].forEach(id=>{
    const inp = el(id); if (!inp) return;
    inp.oninput = ()=>{
      if (id==='cliDir') v.direccion = inp.value;
      if (id==='cliBarrio') v.barrio = inp.value;
      if (id==='valorDom') v.valorDom = num(inp.value);
    };
  });
  const domSel = el('cliDom'); if (domSel) domSel.onchange = ()=>{ v.domiciliario = domSel.value; };
  const obs = el('obsPedido'); if (obs) obs.oninput = ()=>{ v.obsPedido = obs.value; };

  // Guardar / enviar a cocina
  const bGuardar = el('btnGuardarEnviar');
  if (bGuardar) bGuardar.onclick = ()=> guardarEnviarPedido(v);

  // Cobrar
  const bCobrar = el('btnCobrar');
  if (bCobrar) bCobrar.onclick = ()=> abrirModalCobro(v);
}

// Sugerencias de clientes: LISTA con clic (nunca autorrelleno).
function mostrarSugerencias(texto){
  const cont = el('sugerencias'); if (!cont) return;
  const lista = buscarClientes(texto);
  if (!lista.length){ cont.innerHTML=''; return; }
  cont.innerHTML = lista.map(c=>
    `<div class="sug-item" data-key="${esc(c.key)}">
       <b>${esc(c.nombre||'(sin nombre)')}</b> · ${esc(c.telefono||'')}
       <small>${esc(c.direccion||'')} ${esc(c.barrio||'')}</small>
     </div>`).join('');
  cont.querySelectorAll('.sug-item').forEach(d=>
    d.onclick = ()=>{
      const c = (CACHE.clientes||{})[d.dataset.key]; if (!c) return;
      const v = ESTADO.pedidoEnCurso;
      v.cliente=c.nombre; v.telefono=c.telefono; v.direccion=c.direccion; v.barrio=c.barrio;
      cont.innerHTML='';
      render();
    });
}

// Pide cantidad y observación de un producto antes de agregar.
function pedirCantidadYObs(prod, cb){
  modal(`<h3>${esc(prod.nombre)}</h3>
    <label class="lbl">Cantidad</label>
    <input id="mCant" class="inp" type="number" min="1" value="1" inputmode="numeric">
    <label class="lbl">Observación (opcional)</label>
    <input id="mObs" class="inp" placeholder="Ej: sin cebolla, extra picante">
    <div class="modal-acc">
      <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="mOk">Agregar</button>
    </div>`);
  el('mCant').focus();
  el('mOk').onclick = ()=>{ const c=num(el('mCant').value)||1, o=el('mObs').value; cerrarModal(); cb(c,o); };
}

function guardarEnviarPedido(v){
  if (!v.items.length){ mostrarToast('Agrega al menos un producto.'); return; }
  // Validaciones por tipo
  if (v.tipo==='domicilio' && !v.cliente && !v.telefono){
    mostrarToast('Ingresa nombre o teléfono del cliente.'); return;
  }
  // Asignar número de orden si es primera vez
  if (!v.ordenCocina) v.ordenCocina = nuevoNumeroOrden();
  // Guardar cliente si aplica
  if (v.cliente || v.telefono) guardarCliente({nombre:v.cliente,telefono:v.telefono,direccion:v.direccion,barrio:v.barrio});
  fusionarYGuardarVentas(v);
  imprimirComanda(v, false);
  mostrarToast('Pedido enviado a cocina · Orden #'+String(v.ordenCocina).padStart(3,'0'));
  ESTADO.pedidoEnCurso = null; ESTADO._catActiva=null;
  render();
}

/* =======================================================================
   28. MODAL DE COBRO — separa comida/propina/domicilio/recargo (Parte 3.5)
   ======================================================================= */
function abrirModalCobro(v){
  recalcularTotalComida(v);
  const esDom = v.tipo==='domicilio';
  modal(`
    <h3>Cobrar · ${v.factura||v.cliente||('Mesa '+v.mesa)}</h3>
    <div class="cobro-total">Total comida: <b>${pesos(v.totalComida)}</b></div>

    <div class="cobro-sec">
      <div class="cobro-sec-tit">1) Comida (pago dividido permitido)</div>
      <div class="cobro-row">
        <label>Efectivo</label>
        <input id="pgEfectivo" class="inp num" inputmode="numeric" value="${v.totalComida}">
        <div class="hint" id="hEfectivo">${soloMiles(v.totalComida)}</div>
      </div>
      <div class="cobro-row">
        <label>Banco/Transf.</label>
        <input id="pgBanco" class="inp num" inputmode="numeric" value="0">
        <div class="hint" id="hBanco">0</div>
      </div>
      <div class="cobro-row">
        <label>Tarjeta</label>
        <input id="pgTarjeta" class="inp num" inputmode="numeric" value="0">
        <div class="hint" id="hTarjeta">0</div>
      </div>
      <div class="cobro-check" id="cobroCheck"></div>
    </div>

    <div class="cobro-sec">
      <div class="cobro-sec-tit">2) Propina <small>(del mesero, no es venta)</small></div>
      <div class="cobro-row">
        <input id="pgPropina" class="inp num" inputmode="numeric" value="0">
        <div class="hint" id="hPropina">0</div>
        <select id="pgPropinaMet" class="inp">
          <option value="efectivo">Efectivo</option>
          <option value="banco">Banco</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </div>
    </div>

    ${esDom?`<div class="cobro-sec">
      <div class="cobro-sec-tit">3) Domicilio</div>
      <div class="cobro-row">
        <input id="pgDom" class="inp num" inputmode="numeric" value="${v.valorDom||0}">
        <div class="hint" id="hDom">${soloMiles(v.valorDom||0)}</div>
        <select id="pgDomMet" class="inp">
          <option value="efectivo">Efectivo (paga al domic.)</option>
          <option value="banco">Banco</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </div>
    </div>`:''}

    <div class="cobro-sec">
      <div class="cobro-sec-tit">4) Recargo datáfono <small>(lo queda el banco, NO sale del cajón)</small></div>
      <div class="cobro-row">
        <input id="pgRecargo" class="inp num" inputmode="numeric" value="0">
        <div class="hint" id="hRecargo">0</div>
      </div>
    </div>

    <div class="modal-acc">
      <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="btnConfirmarCobro">Confirmar cobro</button>
    </div>
  `);

  // Hints con punto de miles debajo de cada campo (contra errores de digitación).
  const bind = (inp,hint)=>{ const i=el(inp),h=el(hint); if(i&&h) i.oninput=()=>{ h.textContent=soloMiles(i.value); revisarComida(); }; };
  bind('pgEfectivo','hEfectivo'); bind('pgBanco','hBanco'); bind('pgTarjeta','hTarjeta');
  bind('pgPropina','hPropina'); bind('pgRecargo','hRecargo');
  if (esDom) bind('pgDom','hDom');

  function revisarComida(){
    const suma = num(el('pgEfectivo').value)+num(el('pgBanco').value)+num(el('pgTarjeta').value);
    const chk = el('cobroCheck');
    const dif = suma - v.totalComida;
    if (Math.abs(dif)<=1){ chk.className='cobro-check ok'; chk.textContent='✔ Comida cubierta'; }
    else if (dif<0){ chk.className='cobro-check falta'; chk.textContent='Faltan '+pesos(-dif); }
    else { chk.className='cobro-check sobra'; chk.textContent='Sobran '+pesos(dif); }
  }
  revisarComida();

  el('btnConfirmarCobro').onclick = ()=>{
    const pago = {
      pagosVenta: {
        efectivo: num(el('pgEfectivo').value),
        banco:    num(el('pgBanco').value),
        tarjeta:  num(el('pgTarjeta').value),
      },
      propina: num(el('pgPropina').value),
      propinaMetodo: el('pgPropinaMet').value,
      recargo: num(el('pgRecargo').value),
    };
    if (esDom){ pago.valorDom = num(el('pgDom').value); pago.domMetodo = el('pgDomMet').value; }
    const r = cobrarPedido(v, pago);
    if (r.error){ mostrarToast(r.error); return; }
    cerrarModal();
    imprimirFactura(v);
    mostrarToast('Cobro registrado ✔');
    ESTADO.pedidoEnCurso = null; ESTADO._catActiva=null;
    render();
  };
}

/* =======================================================================
   29. VISTA COCINA (KDS)
   ======================================================================= */
function vistaCocina(){
  const pedidos = pedidosParaCocina();
  if (!pedidos.length) return `<div class="cocina-vacio"><h2>👨‍🍳 Cocina</h2><p>No hay pedidos pendientes.</p></div>`;
  const cards = pedidos.map(v=>{
    const min = minutosDesde(v.fecha);
    const color = colorTemporizador(min);
    const dest = v.tipo==='mesa'?('MESA '+v.mesa):v.tipo==='llevar'?'LLEVAR':('DOMICILIO'+(v.barrio?(' · '+v.barrio):''));
    const items = (v.items||[]).map(it=>{
      const esNuevo = (v.nuevosItems||[]).some(n=>n.lineaId===it.lineaId);
      return `<li class="${esNuevo?'kds-nuevo':''}">${it.cantidad}x ${esc(it.nombre)}${it.obs?` <small>(${esc(it.obs)})</small>`:''}</li>`;
    }).join('');
    const avisoAgregado = (v.nuevosItems&&v.nuevosItems.length)?`<div class="kds-aviso">★ AGREGARON PEDIDO</div>`:'';
    const estadoCls = v.cocinaEstado||'pendiente';
    return `<div class="kds-card ${color} ${estadoCls}">
      <div class="kds-head">
        <span class="kds-orden">#${String(v.ordenCocina||0).padStart(3,'0')}</span>
        <span class="kds-timer ${color}">${min}min</span>
      </div>
      <div class="kds-dest">${dest}</div>
      ${avisoAgregado}
      <ul class="kds-items">${items}</ul>
      ${v.obsPedido?`<div class="kds-obs">Obs: ${esc(v.obsPedido)}</div>`:''}
      <div class="kds-acc">
        <button class="btn-mini" data-prep="${v.id}">${v.cocinaEstado==='preparando'?'⏳ Preparando':'▶ Preparar'}</button>
        <button class="btn-mini" data-listo="${v.id}">✔ Listo</button>
        <button class="btn-mini" data-llamar="${v.id}">🔔 Mesero</button>
        <button class="btn-mini" data-recomanda="${v.id}">🖨 Comanda</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="cocina-wrap"><h2 class="sec-title">👨‍🍳 Cocina · ${pedidos.length} pedido(s)</h2>
    <div class="kds-grid">${cards}</div></div>`;
}
function enlazarCocina(){
  const find = id => ventasArray().find(v=>v.id===id);
  document.querySelectorAll('[data-prep]').forEach(b=> b.onclick=()=>{ cocinaMarcar(find(b.dataset.prep),'preparando'); render(); });
  document.querySelectorAll('[data-listo]').forEach(b=> b.onclick=()=>{ const v=find(b.dataset.listo); cocinaMarcar(v,'listo'); llamarMesero(v); render(); });
  document.querySelectorAll('[data-llamar]').forEach(b=> b.onclick=()=>{ llamarMesero(find(b.dataset.llamar)); mostrarToast('Mesero llamado 🔔'); });
  document.querySelectorAll('[data-recomanda]').forEach(b=> b.onclick=()=>{ const v=find(b.dataset.recomanda); v.nuevosItems=[]; imprimirComanda(v,true); render(); });
}

/* =======================================================================
   30. VISTA CAJA
   ======================================================================= */
function vistaCaja(){
  const caja = ESTADO.cajaActual;
  if (!caja){
    return `<div class="caja-cerrada-wrap">
      <h2 class="sec-title">💵 Caja cerrada</h2>
      ${puede('abrirCaja')?`
      <div class="card">
        <label class="lbl">Base inicial (lo contado en el cierre anterior)</label>
        <input id="baseInicial" class="inp num" inputmode="numeric" placeholder="Ej: 100000">
        <div class="hint" id="hBase"></div>
        <button class="btn-primary btn-block" id="btnAbrirCaja">Abrir caja</button>
      </div>`:'<p>No tienes permiso para abrir caja.</p>'}
      ${puede('retiroCajaCerrada')?botonRetiroCajaCerrada():''}
      ${vistaHistorialCierres()}
    </div>`;
  }

  const t = totalesPorMetodo(caja);
  const esperado = calcularEfectivoEsperado(caja);
  const pendientes = pedidosSinCobrarCajaActual();

  const movs = (caja.movimientos||[]).slice().reverse().map(m=>
    `<tr><td>${fmtHora(m.fecha)}</td><td>${m.tipo}</td><td class="right">${pesos(m.valor)}</td><td>${esc(m.motivo)}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="vacio">Sin movimientos</td></tr>';

  const listaPend = pendientes.map(v=>
    `<div class="pend-item">
       <span>${v.factura||v.cliente||('Mesa '+v.mesa)} · ${pesos(v.totalComida)}</span>
       ${puede('cobrar')?`<button class="btn-mini" data-cobrarpend="${v.id}">Cobrar</button>`:''}
     </div>`).join('');

  return `<div class="caja-abierta-wrap">
    <div class="caja-grid">
      <div class="card">
        <h3>Resumen de caja</h3>
        <table class="tabla-caja">
          <tr><td>Base inicial</td><td class="right">${pesos(caja.base)}</td></tr>
          <tr><td>Ventas efectivo</td><td class="right">${pesos(t.efectivo)}</td></tr>
          <tr><td>Ventas banco</td><td class="right">${pesos(t.banco)}</td></tr>
          <tr><td>Ventas tarjeta</td><td class="right">${pesos(t.tarjeta)}</td></tr>
          <tr><td>Propinas</td><td class="right">${pesos(t.propinas)}</td></tr>
          <tr><td>Domicilios</td><td class="right">${pesos(t.domicilios)}</td></tr>
          <tr><td>Recargos</td><td class="right">${pesos(t.recargos)}</td></tr>
          <tr class="fila-total"><td>EFECTIVO ESPERADO</td><td class="right">${pesos(esperado)}</td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Movimientos</h3>
        <div class="mov-botones">
          <button class="btn-mini" data-mov="gasto">− Gasto</button>
          <button class="btn-mini" data-mov="nomina">− Nómina</button>
          <button class="btn-mini" data-mov="entrada">+ Entrada</button>
          <button class="btn-mini" data-mov="retiro">− Retiro</button>
        </div>
        <table class="tabla-mov"><thead><tr><th>Hora</th><th>Tipo</th><th class="right">Valor</th><th>Motivo</th></tr></thead>
          <tbody>${movs}</tbody></table>
      </div>
    </div>
    ${pendientes.length?`<div class="card card-pend"><h3>⚠ ${pendientes.length} pedido(s) sin cobrar</h3>${listaPend}</div>`:''}
    <div class="caja-acciones">
      ${puede('diagnosticoCaja')?'<button class="btn-secondary" id="btnDiagnostico">🔍 Diagnóstico de efectivo</button>':''}
      ${puede('cerrarCaja')?'<button class="btn-primary" id="btnCerrarCaja">Cerrar caja</button>':''}
    </div>
  </div>`;
}
function botonRetiroCajaCerrada(){
  return `<div class="card"><h3>Retiro con caja cerrada</h3>
    <input id="rccValor" class="inp num" inputmode="numeric" placeholder="Valor">
    <input id="rccMotivo" class="inp" placeholder="Motivo">
    <button class="btn-secondary btn-block" id="btnRCC">Registrar retiro</button>
  </div>`;
}
function vistaHistorialCierres(){
  const hist = CACHE.historialCierres || [];
  if (!hist.length) return '';
  const filas = hist.slice(0,20).map(c=>
    `<tr>
       <td>${fmtFecha(c.fecha)}</td><td>${esc(c.cajero||'')}</td>
       <td class="right">${pesos(c.totalVentas)}</td>
       <td class="right">${pesos(c.esperado)}</td>
       <td class="right">${pesos(c.contado)}</td>
       <td class="right ${c.resultado==='FALTA'?'txt-rojo':c.resultado==='SOBRA'?'txt-amar':'txt-verde'}">${c.resultado} ${pesos(c.diferencia)}</td>
       <td><button class="btn-mini" data-verc="${c.id}">Ver</button></td>
     </tr>`).join('');
  return `<div class="card"><h3>Historial de cierres</h3>
    <table class="tabla-hist"><thead><tr><th>Fecha</th><th>Cajero</th><th class="right">Ventas</th><th class="right">Esperado</th><th class="right">Contado</th><th class="right">Resultado</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}

/* =======================================================================
   31. HANDLERS DE CAJA
   ======================================================================= */
function enlazarCaja(){
  // Abrir caja
  const bAbrir = el('btnAbrirCaja');
  if (bAbrir){
    const base = el('baseInicial'), h = el('hBase');
    if (base) base.oninput = ()=> h.textContent = soloMiles(base.value);
    bAbrir.onclick = ()=>{
      const b = num(base.value);
      if (b<0){ mostrarToast('Base inválida.'); return; }
      if (abrirCaja(b)){ mostrarToast('Caja abierta ✔'); render(); }
    };
  }
  // Retiro caja cerrada
  const bRCC = el('btnRCC');
  if (bRCC) bRCC.onclick = ()=>{
    const val = num(el('rccValor').value);
    if (!val){ mostrarToast('Valor requerido.'); return; }
    retiroCajaCerrada(val, el('rccMotivo').value);
    mostrarToast('Retiro registrado.'); render();
  };
  // Movimientos
  document.querySelectorAll('[data-mov]').forEach(b=>
    b.onclick = ()=> modalMovimiento(b.dataset.mov));
  // Cobrar pendiente
  document.querySelectorAll('[data-cobrarpend]').forEach(b=>
    b.onclick = ()=>{ const v=ventasArray().find(x=>x.id===b.dataset.cobrarpend); if (v){ ESTADO.pedidoEnCurso=v; abrirModalCobro(v);} });
  // Diagnóstico
  const bDiag = el('btnDiagnostico');
  if (bDiag) bDiag.onclick = mostrarDiagnostico;
  // Cerrar caja
  const bCerrar = el('btnCerrarCaja');
  if (bCerrar) bCerrar.onclick = ()=> modalCerrarCaja();
  // Ver cierre del historial
  document.querySelectorAll('[data-verc]').forEach(b=>
    b.onclick = ()=>{ const c=(CACHE.historialCierres||[]).find(x=>x.id===b.dataset.verc); if (c) imprimirCierre(c); });
}

function modalMovimiento(tipo){
  const titulos = {gasto:'Registrar gasto', nomina:'Pago de nómina', entrada:'Entrada de efectivo', retiro:'Retiro de efectivo'};
  modal(`<h3>${titulos[tipo]||tipo}</h3>
    <input id="movValor" class="inp num" inputmode="numeric" placeholder="Valor">
    <div class="hint" id="hMov"></div>
    <input id="movMotivo" class="inp" placeholder="Motivo / detalle">
    <div class="modal-acc">
      <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="movOk">Registrar</button>
    </div>`);
  el('movValor').oninput = ()=> el('hMov').textContent = soloMiles(el('movValor').value);
  el('movValor').focus();
  el('movOk').onclick = ()=>{
    const val = num(el('movValor').value);
    if (!val){ mostrarToast('Valor requerido.'); return; }
    movimientoCaja(tipo, val, el('movMotivo').value);
    cerrarModal(); render();
  };
}

function modalCerrarCaja(){
  const esperado = calcularEfectivoEsperado();
  const pendientes = pedidosSinCobrarCajaActual();
  modal(`<h3>Cerrar caja</h3>
    ${pendientes.length?`<div class="alerta-pend">⚠ Hay ${pendientes.length} pedido(s) SIN COBRAR:
      <ul>${pendientes.map(v=>`<li>${esc(v.factura||v.cliente||('Mesa '+v.mesa))} · ${pesos(v.totalComida)}</li>`).join('')}</ul>
      Puedes cerrar de todos modos, pero quedarán sin registrar.</div>`:''}
    <div class="cobro-total">Efectivo esperado: <b>${pesos(esperado)}</b></div>
    <label class="lbl">Efectivo contado físicamente</label>
    <input id="efContado" class="inp num" inputmode="numeric" placeholder="Cuenta el dinero del cajón">
    <div class="hint" id="hContado"></div>
    <div id="difPreview" class="dif-preview"></div>
    <div class="modal-acc">
      <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="btnConfCerrar">Cerrar caja</button>
    </div>`);
  const inp = el('efContado');
  inp.oninput = ()=>{
    el('hContado').textContent = soloMiles(inp.value);
    const dif = num(inp.value) - esperado;
    const dp = el('difPreview');
    if (inp.value===''){ dp.textContent=''; return; }
    if (dif===0){ dp.className='dif-preview verde'; dp.textContent='✔ CUADRADA'; }
    else if (dif>0){ dp.className='dif-preview amar'; dp.textContent='SOBRA '+pesos(dif); }
    else { dp.className='dif-preview rojo'; dp.textContent='FALTA '+pesos(-dif); }
  };
  inp.focus();
  el('btnConfCerrar').onclick = ()=>{
    const contado = num(inp.value);
    const r = cerrarCaja(contado, pendientes.length>0); // ya avisamos arriba
    if (r && r.ok){
      cerrarModal();
      imprimirCierre(r.cierre);
      mostrarToast('Caja cerrada · '+r.cierre.resultado);
      render();
    }
  };
}

function mostrarDiagnostico(){
  const d = diagnosticoEfectivo();
  if (!d){ mostrarToast('No hay caja abierta.'); return; }
  const filas = d.detallePedidos.map(p=>{
    const pv = p.pagos||{};
    return `<tr>
      <td>${esc(p.factura)}</td>
      <td class="right">${pesos(p.comida)}</td>
      <td class="right">${pesos(pv.efectivo)}</td>
      <td class="right">${pesos(pv.banco)}</td>
      <td class="right">${pesos(pv.tarjeta)}</td>
      <td class="right">${p.propina?pesos(p.propina)+' ('+(p.propinaMetodo||'')+')':'-'}</td>
      <td class="right">${p.valorDom?pesos(p.valorDom)+' ('+(p.domMetodo||'')+')':'-'}</td>
      <td class="right">${p.recargo?pesos(p.recargo):'-'}</td>
    </tr>`;
  }).join('');
  modal(`<h3>🔍 Diagnóstico de efectivo</h3>
    <div class="diag-resumen">
      <div>Base: <b>${pesos(d.base)}</b></div>
      <div>Comida efectivo: <b>${pesos(d.comidaEfectivo)}</b></div>
      <div>Entradas: <b>${pesos(d.entradas)}</b></div>
      <div>Gastos: <b>${pesos(d.gastos)}</b> · Nómina: <b>${pesos(d.nomina)}</b> · Retiros: <b>${pesos(d.retiros)}</b></div>
      <div>Sale propina banco: <b>${pesos(d.salidaPropinaBanco)}</b></div>
      <div>Sale domicilio banco: <b>${pesos(d.salidaDomicilioBanco)}</b></div>
      <div class="diag-nota">Recargo (informativo, NO afecta caja): ${pesos(d.recargoTotal)}</div>
      <div class="diag-esp">EFECTIVO ESPERADO: <b>${pesos(d.esperado)}</b></div>
    </div>
    <div class="diag-tabla-wrap">
    <table class="diag-tabla"><thead><tr><th>Factura</th><th class="right">Comida</th><th class="right">Efec</th><th class="right">Banco</th><th class="right">Tarj</th><th class="right">Propina</th><th class="right">Domic</th><th class="right">Recargo</th></tr></thead>
    <tbody>${filas||'<tr><td colspan="8" class="vacio">Sin ventas</td></tr>'}</tbody></table>
    </div>
    <div class="modal-acc"><button class="btn-primary" onclick="cerrarModal()">Cerrar</button></div>`);
}

/* =======================================================================
   32. VISTA DASHBOARD
   ======================================================================= */
function vistaDashboard(){
  const r = resumenJornada();
  const dias = ventasUltimos7Dias();
  const maxDia = Math.max(1, ...dias.map(d=>d.total));
  const barras = dias.map(d=>{
    const h = Math.round((d.total/maxDia)*100);
    return `<div class="barra-wrap"><div class="barra" style="height:${h}%" title="${pesos(d.total)}"></div>
      <div class="barra-lbl">${d.dia.slice(8)}/${d.dia.slice(5,7)}</div></div>`;
  }).join('');
  const activos = pedidosParaCocina().length;
  const alertas = insumosBajoMinimo();
  return `<div class="dash-wrap">
    <h2 class="sec-title">📊 Dashboard</h2>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-val">${pesos(r.totalVendido)}</div><div class="kpi-lbl">Ventas jornada</div></div>
      <div class="kpi"><div class="kpi-val">${r.numVentas}</div><div class="kpi-lbl">Pedidos cobrados</div></div>
      <div class="kpi"><div class="kpi-val">${activos}</div><div class="kpi-lbl">Pedidos activos</div></div>
      <div class="kpi"><div class="kpi-val">${tiempoPromedioEntrega()}min</div><div class="kpi-lbl">Tiempo entrega prom.</div></div>
    </div>
    ${alertas.length?`<div class="dash-alerta">⚠ ${alertas.length} insumo(s) por agotarse: ${alertas.slice(0,5).map(i=>esc(i.nombre)).join(', ')}</div>`:''}
    <div class="dash-cols">
      <div class="card">
        <h3>Últimos 7 días</h3>
        <div class="grafico-barras">${barras}</div>
      </div>
      <div class="card">
        <h3>Métodos de pago (jornada)</h3>
        <table class="tabla-caja">
          <tr><td>Efectivo</td><td class="right">${pesos(r.porMetodo.efectivo)}</td></tr>
          <tr><td>Banco</td><td class="right">${pesos(r.porMetodo.banco)}</td></tr>
          <tr><td>Tarjeta</td><td class="right">${pesos(r.porMetodo.tarjeta)}</td></tr>
        </table>
      </div>
    </div>
    <div class="card">
      <h3>Últimas ventas</h3>
      ${tablaUltimasVentas()}
    </div>
  </div>`;
}
function tablaUltimasVentas(){
  const vs = ventasCajaActual().filter(v=>v.pagado).slice(-12).reverse();
  if (!vs.length) return '<p class="vacio">Sin ventas aún.</p>';
  return `<table class="tabla-ventas"><thead><tr><th>Hora</th><th>Ref</th><th>Tipo</th><th class="right">Total</th><th>Pago</th></tr></thead><tbody>
    ${vs.map(v=>{ const pv=v.pagosVenta||{}; const met=[num(pv.efectivo)&&'Ef',num(pv.banco)&&'Bco',num(pv.tarjeta)&&'Tar'].filter(Boolean).join('/');
      return `<tr><td>${fmtHora(v.fecha)}</td><td>${esc(v.factura||v.cliente||('M'+v.mesa))}</td><td>${v.tipo}</td><td class="right">${pesos(v.totalComida)}</td><td>${met}</td></tr>`;
    }).join('')}</tbody></table>`;
}

/* =======================================================================
   33. VISTA REPORTES
   ======================================================================= */
function vistaReportes(){
  const r = resumenJornada();
  const propinas = Object.entries(r.propinasPorMesero).map(([m,val])=>
    `<tr><td>${esc(m)}</td><td class="right">${pesos(val)}</td></tr>`).join('') || '<tr><td colspan="2" class="vacio">Sin propinas</td></tr>';
  const platos = r.topPlatos.map(([n,c])=>
    `<tr><td>${esc(n)}</td><td class="right">${c}</td></tr>`).join('') || '<tr><td colspan="2" class="vacio">Sin datos</td></tr>';
  return `<div class="rep-wrap">
    <h2 class="sec-title">📈 Reportes</h2>
    <div class="dash-cols">
      <div class="card"><h3>Resumen del día</h3>
        <table class="tabla-caja">
          <tr><td>Total vendido</td><td class="right">${pesos(r.totalVendido)}</td></tr>
          <tr><td>N° pedidos</td><td class="right">${r.numVentas}</td></tr>
          <tr><td>Domicilios</td><td class="right">${pesos(r.domicilios)}</td></tr>
          <tr><td>Recargos</td><td class="right">${pesos(r.recargos)}</td></tr>
        </table>
      </div>
      <div class="card"><h3>Propinas por mesero</h3>
        <table class="tabla-caja">${propinas}</table>
      </div>
    </div>
    <div class="card"><h3>Platos más pedidos</h3>
      <table class="tabla-caja"><thead><tr><th>Plato</th><th class="right">Cantidad</th></tr></thead><tbody>${platos}</tbody></table>
    </div>
    <div class="rep-acc">
      <button class="btn-secondary" id="btnExportar">💾 Exportar respaldo (JSON)</button>
    </div>
  </div>`;
}
function enlazarReportes(){
  const b = el('btnExportar'); if (b) b.onclick = exportarJSON;
}

/* =======================================================================
   34. VISTA AUDITORÍA
   ======================================================================= */
function vistaAuditoria(){
  const arr = CACHE.auditoria || [];
  const filas = arr.slice(0,200).map(a=>
    `<tr><td>${fmtFechaHora(a.fecha)}</td><td>${esc(a.usuario)}</td><td>${esc(a.rol)}</td><td>${esc(a.accion)}</td><td>${esc(a.detalle)}</td></tr>`
  ).join('') || '<tr><td colspan="5" class="vacio">Sin registros</td></tr>';
  return `<div class="aud-wrap"><h2 class="sec-title">🕵️ Auditoría</h2>
    <div class="card"><table class="tabla-aud">
      <thead><tr><th>Fecha</th><th>Usuario</th><th>Rol</th><th>Acción</th><th>Detalle</th></tr></thead>
      <tbody>${filas}</tbody></table></div></div>`;
}

/* =======================================================================
   35. VISTA INVENTARIO (Parte 4) — 5 pestañas
   ======================================================================= */
function vistaInventario(){
  const tab = ESTADO._invTab || 'insumos';
  const tabs = [['insumos','Insumos'],['recetas','Recetas'],['movimientos','Movimientos'],['alertas','Alertas'],['reportes','Reportes']]
    .map(([id,txt])=>`<button class="cat-tab ${tab===id?'activo':''}" data-invtab="${id}">${txt}</button>`).join('');
  let cuerpo='';
  if (tab==='insumos') cuerpo = invInsumos();
  else if (tab==='recetas') cuerpo = invRecetas();
  else if (tab==='movimientos') cuerpo = invMovimientos();
  else if (tab==='alertas') cuerpo = invAlertas();
  else cuerpo = invReportes();
  return `<div class="inv-wrap"><h2 class="sec-title">📦 Inventario</h2>
    <div class="cat-tabs">${tabs}</div>${cuerpo}</div>`;
}
function semaforo(ins){
  const s=num(ins.stock), m=num(ins.stockMinimo);
  if (s<=m) return 'rojo'; if (s<=m*1.5) return 'amar'; return 'verde';
}
function invInsumos(){
  const list = Object.values(CACHE.insumos||{});
  const filas = list.map(i=>
    `<tr>
      <td><span class="sem ${semaforo(i)}"></span>${esc(i.nombre)}</td>
      <td>${esc(i.unidadBase||'')}</td>
      <td class="right">${num(i.stock)}</td>
      <td class="right">${num(i.stockMinimo)}</td>
      ${puede('editarInventario')?`<td>
        <button class="btn-mini" data-inentrada="${i.id}">+ Entrada</button>
        <button class="btn-mini" data-insalida="${i.id}">− Salida</button>
        <button class="btn-mini" data-ineditar="${i.id}">✎</button>
      </td>`:'<td></td>'}
    </tr>`).join('') || '<tr><td colspan="5" class="vacio">Sin insumos. Agrega el primero.</td></tr>';
  return `<div class="card">
    ${puede('editarInventario')?'<button class="btn-primary" id="btnNuevoInsumo">+ Nuevo insumo</button>':''}
    <table class="tabla-inv"><thead><tr><th>Insumo</th><th>Unidad</th><th class="right">Stock</th><th class="right">Mínimo</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
function invRecetas(){
  const prods = [];
  Object.values(CACHE.menu||{}).forEach(arr=> arr.forEach(p=>prods.push(p)));
  const filas = prods.map(p=>{
    const rec = (CACHE.recetas||{})[p.id]||[];
    const resumen = rec.length? rec.map(r=>{ const ins=(CACHE.insumos||{})[r.insumoId]; return (ins?esc(ins.nombre):'?')+' ('+r.cantidad+')'; }).join(', ') : '<i>sin receta</i>';
    return `<tr><td>${esc(p.nombre)}</td><td>${resumen}</td>
      ${puede('editarInventario')?`<td><button class="btn-mini" data-receta="${p.id}">✎ Editar</button></td>`:'<td></td>'}</tr>`;
  }).join('');
  return `<div class="card"><table class="tabla-inv"><thead><tr><th>Producto</th><th>Receta (insumos)</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
function invMovimientos(){
  const movs = [];
  Object.values(CACHE.insumos||{}).forEach(i=>
    (i.historial||[]).forEach(h=> movs.push(Object.assign({insumo:i.nombre}, h))));
  movs.sort((a,b)=> new Date(b.fecha)-new Date(a.fecha));
  const filas = movs.slice(0,150).map(m=>
    `<tr><td>${fmtFechaHora(m.fecha)}</td><td>${esc(m.insumo)}</td><td>${esc(m.tipo)}</td>
      <td class="right ${m.delta<0?'txt-rojo':'txt-verde'}">${m.delta>0?'+':''}${m.delta}</td>
      <td class="right">${m.stockResultante}</td><td>${esc(m.motivo||'')}</td></tr>`
  ).join('') || '<tr><td colspan="6" class="vacio">Sin movimientos</td></tr>';
  return `<div class="card"><table class="tabla-inv"><thead><tr><th>Fecha</th><th>Insumo</th><th>Tipo</th><th class="right">Δ</th><th class="right">Stock</th><th>Motivo</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
function invAlertas(){
  const bajos = insumosBajoMinimo();
  if (!bajos.length) return '<div class="card"><p class="txt-verde">✔ Todos los insumos por encima del mínimo.</p></div>';
  const filas = bajos.map(i=>{
    const falta = Math.max(0, num(i.stockMinimo)*2 - num(i.stock));
    return `<tr><td>${esc(i.nombre)}</td><td class="right">${num(i.stock)}</td><td class="right">${num(i.stockMinimo)}</td><td class="right">${falta} ${esc(i.unidadBase||'')}</td></tr>`;
  }).join('');
  return `<div class="card"><h3>Lista de compras sugerida</h3>
    <table class="tabla-inv"><thead><tr><th>Insumo</th><th class="right">Stock</th><th class="right">Mínimo</th><th class="right">Comprar aprox.</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
function invReportes(){
  const list = Object.values(CACHE.insumos||{});
  let valorTotal = 0;
  const filas = list.map(i=>{
    const val = num(i.stock)*num(i.costo||0);
    valorTotal += val;
    return `<tr><td>${esc(i.nombre)}</td><td class="right">${num(i.stock)}</td><td class="right">${pesos(i.costo||0)}</td><td class="right">${pesos(val)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="vacio">Sin insumos</td></tr>';
  return `<div class="card"><h3>Valorización del inventario</h3>
    <table class="tabla-inv"><thead><tr><th>Insumo</th><th class="right">Stock</th><th class="right">Costo unit.</th><th class="right">Valor</th></tr></thead>
    <tbody>${filas}</tbody><tfoot><tr class="fila-total"><td colspan="3">TOTAL EN STOCK</td><td class="right">${pesos(valorTotal)}</td></tr></tfoot></table></div>`;
}

function enlazarInventario(){
  document.querySelectorAll('[data-invtab]').forEach(b=> b.onclick=()=>{ ESTADO._invTab=b.dataset.invtab; render(); });
  const bN = el('btnNuevoInsumo'); if (bN) bN.onclick = ()=> modalInsumo(null);
  document.querySelectorAll('[data-ineditar]').forEach(b=> b.onclick=()=> modalInsumo((CACHE.insumos||{})[b.dataset.ineditar]));
  document.querySelectorAll('[data-inentrada]').forEach(b=> b.onclick=()=> modalMovInsumo(b.dataset.inentrada,'entrada'));
  document.querySelectorAll('[data-insalida]').forEach(b=> b.onclick=()=> modalMovInsumo(b.dataset.insalida,'salida'));
  document.querySelectorAll('[data-receta]').forEach(b=> b.onclick=()=> modalReceta(b.dataset.receta));
}
function modalInsumo(ins){
  ins = ins || {};
  modal(`<h3>${ins.id?'Editar':'Nuevo'} insumo</h3>
    <input id="inNom" class="inp" placeholder="Nombre" value="${esc(ins.nombre||'')}">
    <div class="cli-row">
      <input id="inUni" class="inp" placeholder="Unidad base (g, ml, und)" value="${esc(ins.unidadBase||'')}">
      <input id="inPres" class="inp" placeholder="Presentación (Paquete x6)" value="${esc(ins.presentacion||'')}">
    </div>
    <div class="cli-row">
      <input id="inStock" class="inp num" inputmode="numeric" placeholder="Stock actual" value="${ins.stock!=null?ins.stock:''}">
      <input id="inMin" class="inp num" inputmode="numeric" placeholder="Stock mínimo" value="${ins.stockMinimo!=null?ins.stockMinimo:''}">
    </div>
    <input id="inCosto" class="inp num" inputmode="numeric" placeholder="Costo de compra (opcional)" value="${ins.costo!=null?ins.costo:''}">
    <div class="modal-acc"><button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="inOk">Guardar</button></div>`);
  el('inOk').onclick = ()=>{
    const obj = Object.assign({}, ins, {
      nombre: el('inNom').value.trim(),
      unidadBase: el('inUni').value.trim(),
      presentacion: el('inPres').value.trim(),
      stock: num(el('inStock').value),
      stockMinimo: num(el('inMin').value),
      costo: num(el('inCosto').value),
    });
    if (!obj.nombre){ mostrarToast('Nombre requerido.'); return; }
    guardarInsumo(obj); cerrarModal(); render();
  };
}
function modalMovInsumo(id, tipo){
  const ins = (CACHE.insumos||{})[id]; if (!ins) return;
  modal(`<h3>${tipo==='entrada'?'Entrada':'Salida'} · ${esc(ins.nombre)}</h3>
    <p>Stock actual: <b>${num(ins.stock)} ${esc(ins.unidadBase||'')}</b></p>
    <input id="movCant" class="inp num" inputmode="numeric" placeholder="Cantidad (${ins.unidadBase||'und'})">
    <input id="movMot" class="inp" placeholder="Motivo (compra, merma, ajuste...)">
    <div class="modal-acc"><button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="movInOk">Registrar</button></div>`);
  el('movInOk').onclick = ()=>{
    const c = num(el('movCant').value); if (!c){ mostrarToast('Cantidad requerida.'); return; }
    movimientoInsumo(id, tipo==='entrada'?+c:-c, el('movMot').value, tipo);
    cerrarModal(); render();
  };
}
function modalReceta(productoId){
  let prod=null; Object.values(CACHE.menu||{}).forEach(arr=>{ const f=arr.find(p=>p.id===productoId); if(f)prod=f; });
  const rec = ((CACHE.recetas||{})[productoId]||[]).slice();
  const insumos = Object.values(CACHE.insumos||{});
  function filasReceta(){
    return rec.map((r,idx)=>{
      const opts = insumos.map(i=>`<option value="${i.id}" ${r.insumoId===i.id?'selected':''}>${esc(i.nombre)} (${esc(i.unidadBase||'')})</option>`).join('');
      return `<div class="rec-row">
        <select class="inp rec-ins" data-idx="${idx}"><option value="">Insumo...</option>${opts}</select>
        <input class="inp num rec-cant" data-idx="${idx}" inputmode="decimal" placeholder="Cant." value="${r.cantidad||''}">
        <button class="btn-mini rec-del" data-idx="${idx}">✕</button>
      </div>`;
    }).join('');
  }
  function pintar(){
    modal(`<h3>Receta · ${esc(prod?prod.nombre:'')}</h3>
      <div id="recLista">${filasReceta()||'<p class="vacio">Sin insumos aún.</p>'}</div>
      <button class="btn-mini" id="recAdd">+ Agregar insumo</button>
      <div class="modal-acc"><button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
        <button class="btn-primary" id="recOk">Guardar receta</button></div>`);
    el('recAdd').onclick=()=>{ rec.push({insumoId:'',cantidad:0}); pintar(); };
    document.querySelectorAll('.rec-del').forEach(b=> b.onclick=()=>{ rec.splice(num(b.dataset.idx),1); pintar(); });
    document.querySelectorAll('.rec-ins').forEach(s=> s.onchange=()=>{ rec[num(s.dataset.idx)].insumoId=s.value; });
    document.querySelectorAll('.rec-cant').forEach(i=> i.oninput=()=>{ rec[num(i.dataset.idx)].cantidad=num(i.value); });
    el('recOk').onclick=()=>{
      const limpia = rec.filter(r=>r.insumoId && num(r.cantidad)>0);
      guardarReceta(productoId, limpia); cerrarModal(); render(); mostrarToast('Receta guardada.');
    };
  }
  pintar();
}

/* =======================================================================
   36. VISTA CONFIGURACIÓN (Parte 3.1 / 3.8) — usuarios, menú, domiciliarios
   ======================================================================= */
function vistaConfig(){
  const tab = ESTADO._cfgTab || 'usuarios';
  const tabs = [['usuarios','Usuarios'],['menu','Menú / Productos'],['domiciliarios','Domiciliarios'],['negocio','Negocio']]
    .map(([id,txt])=>`<button class="cat-tab ${tab===id?'activo':''}" data-cfgtab="${id}">${txt}</button>`).join('');
  let cuerpo='';
  if (tab==='usuarios') cuerpo=cfgUsuarios();
  else if (tab==='menu') cuerpo=cfgMenu();
  else if (tab==='domiciliarios') cuerpo=cfgDomiciliarios();
  else cuerpo=cfgNegocio();
  return `<div class="cfg-wrap"><h2 class="sec-title">⚙️ Configuración</h2>
    <div class="cat-tabs">${tabs}</div>${cuerpo}</div>`;
}

function cfgUsuarios(){
  const us = Object.values(CACHE.usuarios||{});
  const filas = us.map(u=>
    `<tr><td>${esc(u.nombre)}</td><td>${esc(u.usuario)}</td><td>${esc(u.rol)}</td>
      <td>
        <button class="btn-mini" data-usereditar="${esc(u.usuario)}">✎</button>
        ${u.rol!=='admin'?`<button class="btn-mini" data-userborrar="${esc(u.usuario)}">🗑</button>`:''}
      </td></tr>`).join('');
  return `<div class="card">
    <button class="btn-primary" id="btnNuevoUsuario">+ Nuevo usuario</button>
    <table class="tabla-inv"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table>
    <p class="cfg-nota">Roles: admin (total), supervisor, jefe, cajero, mesero, cocina, impresiones.</p>
  </div>`;
}
function cfgMenu(){
  const cats = Object.keys(CACHE.menu||{});
  const bloques = cats.map(cat=>{
    const prods = (CACHE.menu[cat]||[]).map(p=>
      `<tr class="${p.agotado?'fila-agotado':''}">
        <td>${esc(p.nombre)}</td>
        <td class="right">${pesos(p.precio)}</td>
        <td>${p.agotado?'<span class="tag-agotado">AGOTADO</span>':'<span class="tag-ok">Disponible</span>'}</td>
        <td>
          <button class="btn-mini" data-prodagotar="${p.id}">${p.agotado?'Reactivar':'Agotar'}</button>
          <button class="btn-mini" data-prodeditar="${p.id}">✎</button>
          <button class="btn-mini" data-prodborrar="${p.id}">🗑</button>
        </td>
      </tr>`).join('');
    return `<div class="cfg-cat"><h4>${esc(cat)} <button class="btn-mini" data-addprod="${esc(cat)}">+ Producto</button></h4>
      <table class="tabla-inv"><thead><tr><th>Producto</th><th class="right">Precio</th><th>Estado</th><th></th></tr></thead>
      <tbody>${prods||'<tr><td colspan="4" class="vacio">Sin productos</td></tr>'}</tbody></table></div>`;
  }).join('');
  return `<div class="card">
    <button class="btn-primary" id="btnNuevaCat">+ Nueva categoría</button>
    ${bloques}
  </div>`;
}
function cfgDomiciliarios(){
  const doms = (CACHE.domiciliarios||[]).map((d,i)=>
    `<tr><td>${esc(d)}</td><td><button class="btn-mini" data-domborrar="${i}">🗑</button></td></tr>`).join('')
    || '<tr><td colspan="2" class="vacio">Sin domiciliarios</td></tr>';
  return `<div class="card">
    <div class="cli-row">
      <input id="nuevoDom" class="inp" placeholder="Nombre del domiciliario">
      <button class="btn-primary" id="btnAddDom">Agregar</button>
    </div>
    <table class="tabla-inv"><thead><tr><th>Domiciliario</th><th></th></tr></thead><tbody>${doms}</tbody></table>
  </div>`;
}
function cfgNegocio(){
  return `<div class="card">
    <h3>${esc(NEGOCIO.nombre)}</h3>
    <p>${esc(NEGOCIO.rubro)} · ${esc(NEGOCIO.ciudad)}</p>
    <p>Dirección: ${esc(NEGOCIO.direccion)}</p>
    <p>Teléfono: ${esc(NEGOCIO.telefono)}</p>
    <p>Correo: ${esc(NEGOCIO.correo)}</p>
    <p>Prefijo factura: ${esc(NEGOCIO.prefijoFactura)} · Mesas: ${NEGOCIO.numMesas}</p>
    <p class="cfg-nota">Estos datos se personalizan en el archivo <b>app.js</b> (constante NEGOCIO) y aparecen en facturas y comandas.</p>
    <hr>
    <button class="btn-secondary" id="btnExportar2">💾 Exportar respaldo completo (JSON)</button>
  </div>`;
}

function enlazarConfig(){
  document.querySelectorAll('[data-cfgtab]').forEach(b=> b.onclick=()=>{ ESTADO._cfgTab=b.dataset.cfgtab; render(); });

  // --- Usuarios ---
  const bNU = el('btnNuevoUsuario'); if (bNU) bNU.onclick = ()=> modalUsuario(null);
  document.querySelectorAll('[data-usereditar]').forEach(b=> b.onclick=()=> modalUsuario((CACHE.usuarios||{})[b.dataset.usereditar]));
  document.querySelectorAll('[data-userborrar]').forEach(b=> b.onclick=()=>{
    if (!confirm('¿Borrar usuario '+b.dataset.userborrar+'?')) return;
    const us = Object.assign({}, CACHE.usuarios); delete us[b.dataset.userborrar];
    DBset('usuarios', us); ESTADO.usuarios=us; render();
  });

  // --- Menú ---
  const bNC = el('btnNuevaCat'); if (bNC) bNC.onclick = ()=>{
    const nom = prompt('Nombre de la nueva categoría:'); if (!nom) return;
    const menu = Object.assign({}, CACHE.menu); if (!menu[nom]) menu[nom]=[];
    DBset('menu', menu); ESTADO.menu=menu; render();
  };
  document.querySelectorAll('[data-addprod]').forEach(b=> b.onclick=()=> modalProducto(b.dataset.addprod, null));
  document.querySelectorAll('[data-prodeditar]').forEach(b=> b.onclick=()=> modalProductoPorId(b.dataset.prodeditar));
  document.querySelectorAll('[data-prodagotar]').forEach(b=> b.onclick=()=> toggleAgotado(b.dataset.prodagotar));
  document.querySelectorAll('[data-prodborrar]').forEach(b=> b.onclick=()=> borrarProducto(b.dataset.prodborrar));

  // --- Domiciliarios ---
  const bAD = el('btnAddDom'); if (bAD) bAD.onclick = ()=>{
    const nom = el('nuevoDom').value.trim(); if (!nom) return;
    const arr = (CACHE.domiciliarios||[]).slice(); arr.push(nom);
    DBset('domiciliarios', arr); ESTADO.domiciliarios=arr; render();
  };
  document.querySelectorAll('[data-domborrar]').forEach(b=> b.onclick=()=>{
    const arr=(CACHE.domiciliarios||[]).slice(); arr.splice(num(b.dataset.domborrar),1);
    DBset('domiciliarios', arr); ESTADO.domiciliarios=arr; render();
  });

  // --- Negocio ---
  const bE2 = el('btnExportar2'); if (bE2) bE2.onclick = exportarJSON;
}

// --- Helpers de configuración ---
function modalUsuario(u){
  u = u || {};
  const roles = ROLES.map(r=>`<option value="${r}" ${u.rol===r?'selected':''}>${r}</option>`).join('');
  modal(`<h3>${u.usuario?'Editar':'Nuevo'} usuario</h3>
    <input id="uNom" class="inp" placeholder="Nombre" value="${esc(u.nombre||'')}">
    <input id="uUser" class="inp" placeholder="Usuario (para ingresar)" value="${esc(u.usuario||'')}" ${u.usuario?'readonly':''}>
    <input id="uClave" class="inp" placeholder="Contraseña" value="${esc(u.clave||'')}">
    <select id="uRol" class="inp">${roles}</select>
    <div class="modal-acc"><button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="uOk">Guardar</button></div>`);
  el('uOk').onclick = ()=>{
    const usuario = el('uUser').value.trim();
    if (!usuario || !el('uClave').value){ mostrarToast('Usuario y contraseña requeridos.'); return; }
    const us = Object.assign({}, CACHE.usuarios||{});
    us[usuario] = { usuario, nombre: el('uNom').value.trim()||usuario, clave: el('uClave').value, rol: el('uRol').value };
    DBset('usuarios', us); ESTADO.usuarios=us;
    registrarAuditoria('GESTION_USUARIO', usuario+' ('+el('uRol').value+')');
    cerrarModal(); render();
  };
}
function buscarProductoPorId(id){
  let res=null, cat=null;
  Object.entries(CACHE.menu||{}).forEach(([c,arr])=>{ const f=arr.find(p=>p.id===id); if(f){res=f;cat=c;} });
  return {prod:res, cat};
}
function modalProductoPorId(id){ const {prod,cat}=buscarProductoPorId(id); modalProducto(cat, prod); }
function modalProducto(categoria, prod){
  prod = prod || {};
  modal(`<h3>${prod.id?'Editar':'Nuevo'} producto · ${esc(categoria)}</h3>
    <input id="pNom" class="inp" placeholder="Nombre" value="${esc(prod.nombre||'')}">
    <input id="pPrecio" class="inp num" inputmode="numeric" placeholder="Precio" value="${prod.precio||''}">
    <div class="hint" id="hPrecio">${prod.precio?soloMiles(prod.precio):''}</div>
    <div class="modal-acc"><button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
      <button class="btn-primary" id="pOk">Guardar</button></div>`);
  el('pPrecio').oninput = ()=> el('hPrecio').textContent = soloMiles(el('pPrecio').value);
  el('pOk').onclick = ()=>{
    const nombre = el('pNom').value.trim(); const precio = num(el('pPrecio').value);
    if (!nombre || !precio){ mostrarToast('Nombre y precio requeridos.'); return; }
    const menu = Object.assign({}, CACHE.menu);
    menu[categoria] = (menu[categoria]||[]).slice();
    if (prod.id){
      const i = menu[categoria].findIndex(p=>p.id===prod.id);
      if (i>=0) menu[categoria][i] = Object.assign({}, prod, {nombre, precio});
    } else {
      menu[categoria].push({ id: uid('p'), nombre, precio, agotado:false });
    }
    DBset('menu', menu); ESTADO.menu=menu; cerrarModal(); render();
  };
}
function toggleAgotado(id){
  const menu = Object.assign({}, CACHE.menu);
  Object.keys(menu).forEach(c=>{
    menu[c] = menu[c].map(p=> p.id===id ? Object.assign({}, p, {agotado:!p.agotado}) : p);
  });
  DBset('menu', menu); ESTADO.menu=menu; render();
}
function borrarProducto(id){
  if (!confirm('¿Borrar este producto del menú?')) return;
  const menu = Object.assign({}, CACHE.menu);
  Object.keys(menu).forEach(c=>{ menu[c] = menu[c].filter(p=>p.id!==id); });
  DBset('menu', menu); ESTADO.menu=menu; render();
}

/* =======================================================================
   37. EXPOSICIÓN GLOBAL (handlers inline del HTML) + DISPARADOR DE ARRANQUE
   Los atributos onclick="..." del HTML se resuelven contra window; exponemos
   explícitamente lo que necesitan para máxima robustez entre navegadores.
   ======================================================================= */
if (typeof window !== 'undefined'){
  window.ESTADO = ESTADO;
  window.render = render;
  window.logout = logout;
  window.bloquearPantalla = bloquearPantalla;
  window.cerrarModal = cerrarModal;
  // Utilidades y API principal (facilita pruebas e integraciones):
  Object.assign(window, {
    login, abrirCaja, cerrarCaja, crearPedido, agregarItem, cobrarPedido,
    calcularEfectivoEsperado, nuevoNumeroOrden, fusionarYGuardarVentas,
    eliminarFactura, quitarProducto, editarFormaPago, anularPedido,
    guardarInsumo, guardarReceta, movimientoInsumo, pedidosParaCocina,
    recalcularTotalComida, num, pesos, CACHE, NEGOCIO
  });
}


/* Arranque robusto: cubre loading, interactive y complete. */
(function iniciarPOS(){
  let arrancado = false;
  function go(){ if (arrancado) return; arrancado = true; try { arrancar(); } catch(e){ console.error('Arranque:', e); } }
  if (document.readyState === 'complete' || document.readyState === 'interactive'){
    // DOM ya disponible: arrancar en el siguiente tick para asegurar que todo el script cargó.
    setTimeout(go, 0);
  } else {
    document.addEventListener('DOMContentLoaded', go);
  }
  // Respaldo definitivo por si DOMContentLoaded no dispara en algún entorno.
  window.addEventListener('load', go);
  window.arrancarPOS = go; // permite arranque manual/pruebas
})();
