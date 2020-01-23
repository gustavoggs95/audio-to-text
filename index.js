const path = require('path');
const os = require('os');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');  
const mime = require('mime'); 

// Node.js doesn't have a built-in multipart/form-data parsing library.
// Instead, we can use the 'busboy' library from NPM to parse these requests.
const Busboy = require('busboy');
const Speech = require('@google-cloud/speech');

const ENCODING = 'LINEAR16';
const SAMPLE_RATE_HERTZ = 22050;
const LANGUAGE = 'es-ES';

// const audioConfig = {
//     encoding: ENCODING,
//     // sampleRateHertz: SAMPLE_RATE_HERTZ,
//     languageCode: LANGUAGE,
//     // audioChannelCount: 1,
// };

const convertToText = (file, config) => {
    console.log('FILE:', JSON.stringify(file));

    const audio = {
        content: fs.readFileSync(file).toString('base64'),
    };

    const request = {
        config,
        audio,
    };

    const speech = new Speech.SpeechClient();

    return speech.recognize(request).then((response) => {
        return response;
    }).catch((error) => {
        console.log('SPEECH error:', error);
    });
};

/**
 * Audio-to-Text is a Cloud Function that is triggered by an HTTP
 * request. The function processes one audio file.
 *
 * @param {object} req Cloud Function request context.
 * @param {object} res Cloud Function response context.
 */
exports.audioToText = (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).end();
    }
    res.set('Access-Control-Allow-Origin', "*")
    res.set('Access-Control-Allow-Methods', 'GET, POST')

    const busboy = new Busboy({ headers: req.headers });
    const tmpdir = os.tmpdir();

    let tmpFilePath;
    let fileWritePromise;

    // Process the file
    busboy.on('file', (fieldname, file, filename) => {
        console.log('busboy filename: ', filename)
        // Note: os.tmpdir() points to an in-memory file system on GCF
        // Thus, any files in it must fit in the instance's memory.
        const filepath = path.join(tmpdir, filename);
        tmpFilePath = filepath;

        const writeStream = fs.createWriteStream(filepath);
        file.pipe(writeStream);

        // File was processed by Busboy; wait for it to be written to disk.
        const promise = new Promise((resolve, reject) => {
            file.on('end', () => {
                writeStream.end();
            });
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        fileWritePromise = promise;
    });

    const newProm = (tmpFilePath, filePathOut) => new Promise((resolve, reject) => {  
        if (!tmpFilePath || !filePathOut) {
            throw new Error('You must specify a path for both input and output files.');
        }
        if (!fs.existsSync(tmpFilePath)) {
            throw new Error('Input file must exist.');
        }
        
            try {
                // let stream  = fs.createWriteStream('/tmp/outputfile.wav');
                ffmpeg()
                    .input(tmpFilePath)
                    .outputOptions([
                        '-acodec pcm_s16le',
                        '-vn',
                        '-ac 1',
                        '-ar 44100'
                    ])
                    .save(filePathOut)
                    .on('end', () => {
                        let audioConfig = {
                            encoding: 'LINEAR16',
                            languageCode: req.query.language
                        }
                        convertToText(filePathOut, audioConfig).then((response) => {
                            console.log('response: ', response)
                            const transcript = response[0].results
                                .map(result => result.alternatives[0].transcript)
                                .join('\n');

                                console.log('test 2: ', req.query)
                                let current = req.query.message.toLowerCase().replace(/\.|\?|\- |\– |\!/g,'').split(' ')
                                let userSpeech = transcript.toLowerCase().split(' ')
                                let correctCount = 0
                            
                                let checkAnswers = []
                            
                                for(let i = 0; i< userSpeech.length; i++){
                                  if(current.indexOf(userSpeech[i]) >= 0){
                                    checkAnswers.push({ word: userSpeech[i], is_right: true })
                                    correctCount++
                                  }else{
                                    checkAnswers.push({ word: userSpeech[i], is_right: false })
                                  }
                                }
                            
                                let processedAnswers = {
                                  distance: 100 - ( (correctCount / current.length) * 100),
                                  ratio: correctCount / current.length,
                                  is_match: correctCount == current.length,
                                  query: checkAnswers
                                }

                            res.send(processedAnswers);
                        });
                    })
                    .on('error', function(err, stdout, stderr) {
                        console.log('Cannot process video: ' + err.message);
                      })
                      .run()

                      

            } catch (e) {
                reject(e);
            }
    })

    // Triggered once the file is processed by Busboy.
    // Need to wait for the disk writes to complete.
    busboy.on('finish', () => {
        fileWritePromise.then(() => {
            console.log('tmpFilePath: ', tmpFilePath)

            let filePathOut = '/tmp/output.wav'
            
            fs.readdirSync('/tmp/').forEach(file => {
                console.log('file: ', file);
              });

            newProm(tmpFilePath, filePathOut).then(res => {
                console.log('success')
            }).catch(err => {
                console.log('error: ', err)
            })

            // convertToText(tmpFilePath, audioConfig).then((response) => {
            //     console.log('response: ', response)
            //     const transcript = response[0].results
            //         .map(result => result.alternatives[0].transcript)
            //         .join('\n');
            //     res.send({ transcript });
            // });
            // fs.unlinkSync(tmpFilePath);

        });
    });

    busboy.end(req.rawBody);
};
