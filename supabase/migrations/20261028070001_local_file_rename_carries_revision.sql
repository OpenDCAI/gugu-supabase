-- Renaming or moving a project file whose bytes stay on the host (workspace_move_as) makes its next version, and a local
-- version is readable only through its file_device_revisions row. Carry the current version's row to the next version
-- under the new name (same device, project, path and bytes), so the rename stands and the file stays readable.
-- Who may do it is unchanged: file_device_read_only, which fires after this trigger (triggers fire in name order),
-- still refuses everyone but the bound host and rolls this row back with the statement.
CREATE FUNCTION chat.file_device_carry_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d chat.file_device_revisions%ROWTYPE;
BEGIN
    IF NEW.kind<>'file' OR NEW.chat_id<>OLD.chat_id OR NEW.version<>OLD.version+1
       OR OLD.blob_id IS NOT NULL OR NEW.blob_id IS NOT NULL
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.content_type IS DISTINCT FROM OLD.content_type
       -- A publication writes its own row for the new version before it updates the file.
       OR EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=NEW.id AND version=NEW.version) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO d FROM chat.file_device_revisions WHERE item_id=OLD.id AND version=OLD.version;
    IF NOT FOUND THEN RETURN NEW; END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(NEW.id,NEW.version,d.host_device_id,d.host_project_id,d.relative_path,d.sha256,d.size_bytes,NEW.filename,d.content_type);
    RETURN NEW;
END $$;
CREATE TRIGGER file_device_carry_revision BEFORE UPDATE ON chat.workspace_items
    FOR EACH ROW EXECUTE FUNCTION chat.file_device_carry_revision();
REVOKE ALL ON FUNCTION chat.file_device_carry_revision() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_device_carry_revision() TO service_role;
