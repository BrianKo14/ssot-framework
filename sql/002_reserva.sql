-- Every build-in domain type.

create table reserva (
  fecha       date          not null,
  id          integer       not null,
  cliente     integer,
  nombre      varchar(100)  not null,
  notas       text,
  hora        time,
  creado_en   timestamp,
  duracion    interval,
  importe     numeric(12,2),
  confirmada  boolean,
  constraint reserva_pk primary key (fecha, id),
  -- A lookup: `cliente` is not part of reserva's pk. It mounts no nested route, unlike 003's detalle.
  constraint reserva_cliente_fk foreign key (cliente) references cliente (id)
);
insert into reserva (fecha, id, cliente, nombre) values ('2026-01-01', 7, 1, 'Ada');
