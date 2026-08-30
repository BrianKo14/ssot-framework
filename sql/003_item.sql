-- Master / detail
-- `item` is a detail of `reserva`, because the columns of its fk (fecha, id) are part of item's own primary key

create table item (
  fecha        date          not null,
  id           integer       not null,
  item         integer       not null,
  descripcion  varchar(100)  not null,
  cantidad     integer,
  constraint item_pk primary key (fecha, id, item),
  constraint item_reserva_fk foreign key (fecha, id) references reserva (fecha, id)
);
