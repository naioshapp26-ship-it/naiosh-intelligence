-- «تغذية البيانات»: files attached to a trained answer (PDF, images, Excel, Word, video …), shown with the answer in «اسأل نايوش».
-- JSON array of upload ids; the upload rows get kind 'qa' so the orphan cleanup never removes them.
ALTER TABLE qa_entries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
