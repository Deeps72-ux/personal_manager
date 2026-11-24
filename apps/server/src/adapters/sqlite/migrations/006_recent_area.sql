-- The TASKS tab's "recent" area: new and moved-in tasks and folders sit at
-- the very top of their folder, mixed and above the sub-folders, until they
-- are dragged out. Everything that exists today stays where it is (0).
ALTER TABLE tasks ADD COLUMN folder_top INTEGER NOT NULL DEFAULT 0 CHECK (folder_top IN (0, 1));
ALTER TABLE folders ADD COLUMN top INTEGER NOT NULL DEFAULT 0 CHECK (top IN (0, 1));
