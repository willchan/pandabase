-- Synthetic fixture: drops a column the previous release still reads.
ALTER TABLE `item` drop column `legacy_note`;
