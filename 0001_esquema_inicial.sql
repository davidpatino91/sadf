-- ============================================================================
-- SADF — Sistema de Administración de Deuda Financiera
-- Migración 0001: esquema inicial para Supabase (PostgreSQL 15+)
-- ============================================================================
-- Las tablas reflejan el modelo de datos del cliente (sistema-deuda-financiera.jsx).
-- Todo usuario autenticado tiene acceso completo (CRUD) a todas las tablas.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLAS
-- ----------------------------------------------------------------------------

-- Refleja EXACTAMENTE la forma del objeto Credito del cliente (camelCase se
-- convierte a snake_case, pero los nombres son los mismos):
--   id, banco, numeroObligacion, descripcion, valorDesembolsado,
--   fechaDesembolso, fechaVencimiento, plazoMeses, spread,
--   periodicidadIntereses, periodicidadCapital, mesesGracia,
--   tipoAmortizacion, estado, observaciones
create table public.creditos (
  id                      text primary key,
  banco                   text not null check (length(trim(banco)) between 1 and 80),
  numero_obligacion       text not null,
  descripcion             text not null default '',
  valor_desembolsado      numeric(18,2) not null check (valor_desembolsado > 0),
  fecha_desembolso        date not null,
  fecha_vencimiento       date not null,
  plazo_meses             integer not null check (plazo_meses > 0),
  spread                  numeric(8,4) not null check (spread >= 0),
  periodicidad_intereses  text not null check (periodicidad_intereses in ('Mensual', 'Trimestral', 'Semestral', 'Anual')),
  periodicidad_capital    text not null check (periodicidad_capital   in ('Mensual', 'Trimestral', 'Semestral', 'Anual')),
  meses_gracia            integer not null default 0 check (meses_gracia >= 0),
  tipo_amortizacion       text not null check (tipo_amortizacion in ('capital_constante', 'capital_constante_gracia')),
  estado                  text not null default 'Activo' check (estado in ('Activo', 'En gracia', 'Mora', 'Cancelado')),
  observaciones           text not null default '',
  creado_por              uuid references auth.users(id),
  creado_en               timestamptz not null default now(),
  actualizado_en          timestamptz not null default now(),

  unique (numero_obligacion),
  constraint chk_fechas_coherentes check (fecha_vencimiento > fecha_desembolso),
  constraint chk_gracia            check (tipo_amortizacion <> 'capital_constante_gracia' or (meses_gracia > 0 and meses_gracia < plazo_meses))
);
create index idx_creditos_estado      on public.creditos (estado);
create index idx_creditos_vencimiento on public.creditos (fecha_vencimiento);

-- Refleja el modelo TasaIBR del cliente: { id, fecha, valorEA, fuente }
create table public.historico_ibr (
  id             text primary key,
  fecha          date not null unique,
  valor_ea       numeric(8,4) not null check (valor_ea >= 0 and valor_ea < 100),
  fuente         text not null default 'Manual',
  creado_por     uuid references auth.users(id),
  creado_en      timestamptz not null default now()
);
create index idx_historico_ibr_fecha on public.historico_ibr (fecha desc);

-- Configuración global (una sola fila). bancos se almacena como JSONB porque
-- el cliente lo maneja como un arreglo de objetos {id, nombre, activo}.
create table public.configuracion (
  id              integer primary key default 1 check (id = 1),
  bancos          jsonb not null default '[]'::jsonb,
  decimales       integer not null default 0 check (decimales in (0, 2)),
  actualizado_en  timestamptz not null default now()
);

-- Auditoría: la escriben ÚNICAMENTE los triggers (inmutable desde el cliente)
create table public.auditoria (
  id             bigint generated always as identity primary key,
  fecha_hora     timestamptz not null default now(),
  accion         text not null,
  usuario        text not null,
  descripcion    text not null
);
create index idx_auditoria_fecha on public.auditoria (fecha_hora desc);

-- ----------------------------------------------------------------------------
-- 2. TRIGGERS: updated_at en creditos + auditoría automática
-- ----------------------------------------------------------------------------

create or replace function public.tg_actualizar_timestamp()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;
create trigger creditos_actualizado before update on public.creditos
  for each row execute function public.tg_actualizar_timestamp();

create or replace function public.tg_auditar()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_accion text;
  v_descripcion text;
begin
  v_accion := tg_table_name || ':' || lower(tg_op);

  if tg_table_name = 'creditos' then
    v_descripcion := case tg_op
      when 'INSERT' then 'Se creó el crédito '    || new.numero_obligacion
      when 'UPDATE' then 'Se editó el crédito '   || new.numero_obligacion
      when 'DELETE' then 'Se eliminó el crédito ' || old.numero_obligacion
    end;
  elsif tg_table_name = 'historico_ibr' then
    v_descripcion := case tg_op
      when 'INSERT' then 'Se registró la tasa IBR del '  || new.fecha
      when 'UPDATE' then 'Se actualizó la tasa IBR del ' || new.fecha
      when 'DELETE' then 'Se eliminó la tasa IBR del '   || old.fecha
    end;
  else
    v_descripcion := tg_op || ' en ' || tg_table_name;
  end if;

  insert into public.auditoria (usuario, accion, descripcion)
  values (coalesce((select auth.jwt() ->> 'email'), 'sistema'), v_accion, v_descripcion);

  return coalesce(new, old);
end;
$$;

create trigger creditos_auditar after insert or update or delete on public.creditos
  for each row execute function public.tg_auditar();
create trigger ibr_auditar after insert or update or delete on public.historico_ibr
  for each row execute function public.tg_auditar();
create trigger config_auditar after update on public.configuracion
  for each row execute function public.tg_auditar();

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--    Todos los usuarios autenticados tienen acceso completo (CRUD).
--    Las invitaciones (altas de usuario) se gestionan desde Supabase Auth.
-- ----------------------------------------------------------------------------

alter table public.creditos          enable row level security;
alter table public.historico_ibr     enable row level security;
alter table public.configuracion     enable row level security;
alter table public.auditoria         enable row level security;

create policy creditos_all on public.creditos
  for all to authenticated using (true) with check (true);
create policy ibr_all on public.historico_ibr
  for all to authenticated using (true) with check (true);
create policy configuracion_all on public.configuracion
  for all to authenticated using (true) with check (true);
create policy auditoria_all on public.auditoria
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- 4. FUNCIONES RPC
-- ----------------------------------------------------------------------------

-- 4.1 Respaldo completo de la base de datos.
create or replace function public.generar_respaldo()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Se requiere un usuario autenticado.';
  end if;
  return jsonb_build_object(
    'version', 2,
    'generadoEl', now(),
    'creditos', coalesce((select jsonb_agg(to_jsonb(c)) from public.creditos c), '[]'::jsonb),
    'historicoIBR', coalesce((select jsonb_agg(to_jsonb(h)) from public.historico_ibr h), '[]'::jsonb),
    'configuracion', (select to_jsonb(cf) from public.configuracion cf)
  );
end;
$$;

-- 4.2 Restauración desde respaldo.
create or replace function public.restaurar_respaldo(p_datos jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
begin
  if (select auth.uid()) is null then
    raise exception 'Se requiere un usuario autenticado.';
  end if;
  if p_datos is null or jsonb_typeof(p_datos -> 'creditos') <> 'array' then
    raise exception 'El respaldo no tiene el formato esperado.';
  end if;

  delete from public.creditos;
  delete from public.historico_ibr;

  if jsonb_typeof(p_datos -> 'creditos') = 'array' then
    insert into public.creditos
      select * from jsonb_populate_recordset(null::public.creditos, p_datos -> 'creditos');
  end if;

  if jsonb_typeof(p_datos -> 'historicoIBR') = 'array' then
    insert into public.historico_ibr
      select * from jsonb_populate_recordset(null::public.historico_ibr, p_datos -> 'historicoIBR')
      on conflict (fecha) do update set valor_ea = excluded.valor_ea, fuente = excluded.fuente;
  end if;

  return jsonb_build_object('restaurado', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. PERMISOS DE EJECUCIÓN (solo usuarios autenticados; nunca anónimos)
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function public.generar_respaldo()      to authenticated;
grant execute on function public.restaurar_respaldo(jsonb) to authenticated;
