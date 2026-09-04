const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const mime = file.mimetype;
  if (mime.startsWith('image') || mime.startsWith('video') || mime.startsWith('audio')) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || 52428800) },
});

module.exports = { upload };
