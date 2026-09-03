const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

['', 'images', 'videos', 'voice'].forEach(dir => {
  fs.mkdirSync(path.join(UPLOAD_DIR, dir), { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let sub = 'images';
    if (file.mimetype.startsWith('video')) sub = 'videos';
    else if (file.mimetype.startsWith('image')) sub = 'images';
    else if (file.mimetype.startsWith('audio')) sub = 'voice';
    cb(null, path.join(UPLOAD_DIR, sub));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${uuidv4()}${ext}`);
  },
});

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

module.exports = { upload, UPLOAD_DIR };
