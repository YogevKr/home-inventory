ALTER TABLE attachments ADD COLUMN removed_at TEXT;
ALTER TABLE attachments ADD COLUMN updated_by TEXT;
ALTER TABLE activity ADD COLUMN attachment_id TEXT REFERENCES attachments(id);

CREATE TRIGGER attachment_visibility_changed
AFTER UPDATE OF removed_at ON attachments
WHEN OLD.removed_at IS NOT NEW.removed_at
BEGIN
  INSERT INTO activity(item_id,actor,action,attachment_id)
  VALUES(
    NEW.item_id,
    NEW.updated_by,
    CASE WHEN NEW.removed_at IS NULL THEN 'Restored file: ' ELSE 'Removed file: ' END || NEW.filename,
    NEW.id
  );
END;
