-- A project chat's binding to its host project (chat.file_project_policies) was deleted with the host's project row, and
-- a host drops that row whenever one publication of its project list leaves the project out
-- (identity.publish_device_projects). The project came back on the next publication; the binding did not, so every file
-- the chat keeps on its host read as gone until the host happened to publish a file again.
-- The binding now outlives its project row. Every reader already joins it to a current project row of the same device,
-- project and chat, so while the project is not listed its files are refused as before, and when it is listed again they
-- read again. Deleting the chat still deletes the binding.
ALTER TABLE chat.file_project_policies DROP CONSTRAINT file_project_policies_host_device_id_host_project_id_fkey;

-- Chats that already lost their binding this way: their host's local revisions name the device and project, and that
-- project is listed again for the chat. Bind each to the one whose revision is newest.
INSERT INTO chat.file_project_policies(chat_id,host_device_id,host_project_id)
SELECT DISTINCT ON (w.chat_id) w.chat_id,d.host_device_id,d.host_project_id
  FROM chat.file_device_revisions d
  JOIN chat.workspace_items w ON w.id=d.item_id
  JOIN identity.device_projects dp ON dp.device_id=d.host_device_id AND dp.local_project_id=d.host_project_id AND dp.chat_id=w.chat_id
 WHERE NOT EXISTS(SELECT 1 FROM chat.file_project_policies p WHERE p.chat_id=w.chat_id)
 ORDER BY w.chat_id,w.updated_at DESC,d.version DESC
ON CONFLICT(chat_id) DO NOTHING;
