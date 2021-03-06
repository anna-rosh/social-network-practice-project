const express = require('express');
const app = express();
const server = require("http").Server(app);
const io = require("socket.io")(server, { origins: "localhost:8080" });
const compression = require('compression');
const cookieSession = require('cookie-session');
const db = require('./db');
const bc = require('./bc');
const csurf = require('csurf');
const cryptoRandomString = require("crypto-random-string");
const ses = require('./ses');
const multer = require("multer");
const s3 = require("./s3");
const { s3Url } = require("./config");
const uidSafe = require("uid-safe");
const path = require("path");
// compression makes the responses smaller and the application faster (can be used in any server)
app.use(compression());

if (process.env.NODE_ENV != 'production') {
    app.use(
        '/bundle.js',
        require('http-proxy-middleware')({
            target: 'http://localhost:8081/'
        })
    );
} else {
    // this code will only run if the application will be published online
    app.use('/bundle.js', (req, res) => res.sendFile(`${__dirname}/bundle.js`));
}

app.use(express.json());

// new cookie session middleware for using with socket
const cookieSessionMiddleware = cookieSession({
    secret: `I'm always angry.`,
    maxAge: 1000 * 60 * 60 * 24 * 90,
});

app.use(cookieSessionMiddleware);
io.use(function (socket, next) {
    cookieSessionMiddleware(socket.request, socket.request.res, next);
});
// END new cookie session middleware

app.use(csurf());

app.use(function (req, res, next) {
    res.cookie("mytoken", req.csrfToken());
    next();
});

app.use(express.static('./public'));

const diskStorage = multer.diskStorage({
    destination: function (req, file, callback) {
        callback(null, __dirname + "/uploads");
    },
    filename: function (req, file, callback) {
        uidSafe(24).then(function (uid) {
            callback(null, uid + path.extname(file.originalname));
        });
    },
});

const uploader = multer({
    storage: diskStorage,
    limits: {
        fileSize: 2097152,
    },
});

///////////////////////////////////// END MIDDLEWARE & OTHER SETTINGS ////////////////////////////

app.get('/welcome', (req, res) => {
    if (req.session.userId) {
        res.redirect('/');
    } else {
        res.sendFile(__dirname + "/index.html");
    }
});

app.post('/register', (req, res) => {

    const { first, last, email, password } = req.body;

    bc.hash(password)
        .then((hashedPassword) => {
            db.addUser(first, last, email, hashedPassword)
                .then(({ rows }) => {
                    req.session.userId = rows[0].id;
                    res.json({ error: false });
                })
                .catch((err) => {
                    console.log("ERR in addUser: ", err);
                    res.json({ error: true });
                });
        })
        .catch((err) => {
            console.log("err in hash: ", err);
            res.json({ error: true });
        });

});

app.post('/login', (req, res) => {

    const { email, password } = req.body;

    db.checkEmail(email)
        .then(({ rows }) => {
            const { password:encodedPassword, id } = rows[0];

            bc.compare(password, encodedPassword)
                .then((result) => {
                    if (result == true) {
                        req.session.userId = id;
                        res.json({ error: false });
                    } else {
                        res.json({ error: true });
                    }
                })
                .catch(err => {
                    console.log('err in bc.compare: ', err);
                    res.json({ error: true });
                });

        })
        .catch(err => {
            console.log('err in checkEmail: ', err);
            res.json({ error: true });
        });

});

app.post('/password/reset/start', (req, res) => {
    const { email } = req.body;

    db.checkEmail(email)
        .then(() => {
            const resetCode = cryptoRandomString({ length: 6 });

            db.addCode(email, resetCode)
                .then(() => {
                    ses.sendEmail(email, `please use the following code to reset your password: ${resetCode}`, 'reset your password');

                    res.json({ error: false });
                })
                .catch(err => {
                    console.log('err in addCode: ', err);
                    res.json({ error: true });
                });
        })
        .catch(err => {
            console.log('err in checkEmail for reseting password: ', err);
            res.json({ error: true });
        });

});

app.post('/password/reset/verify', (req, res) => {
    // in req.body we expect to find the properties: code, password, email
    const { code, password, email } = req.body;

    db.getResentCode(email)
        .then(({ rows }) => {
            const currentCode = rows[0].code;

            if (code !== currentCode) {
                res.json({ error: true });
            } else {
                bc.hash(password)
                    .then(hashedPassword => {

                        db.updatePassword(hashedPassword, email)
                            .then(() => {
                                res.json({ error: false });
                            })
                            .catch(err => {
                                console.log('err in hash for pw-updating: ', err);
                                res.json({ error: true });
                            });

                    })
                    .catch();
            }
        })
        .catch(err => {
            console.log('err in getResentCode: ', err);
            res.json({ error: true});
        });

});

app.get('/user', async (req, res) => {

    try {
        const { rows } = await db.getUserById(req.session.userId);
        res.json(rows[0]);
    } catch (err) {
        console.log("err in getUserById: ", err);
    }

});

app.post("/upload-profile-picture", uploader.single("file"), s3.upload, async (req, res) => {

    if (!req.file) {
        res.json({ error: true });
    } else {
        const { filename } = req.file;
        const imageUrl = `${s3Url}${req.session.userId}/${filename}`;

        try {
            const { rows } = await db.updateProfilePicUrl(imageUrl, req.session.userId);
            res.json(rows[0]);

        } catch (err) {
            console.log("err in updateProfilePicUrl", err);
        }

    } // closes else statement

});

app.post("/update-bio", async (req, res) => {
    // getting { bio: somevalue } from the client side in req.body
    try {
        const { rows } = await db.updateBio(req.body.bio, req.session.userId);
        res.json(rows[0]);

    } catch (err) {
        console.log('err in updateBio: ', err);
        res.json({ error: true });
    }

});

app.get('/api/user/:id', async (req, res) => {

    try {
        const { rows } = await db.getUserById(req.params.id);

        if (!rows[0]) {
            res.json({ error: true });
        } else {
            res.json({
                ...rows[0],
                currUserId: req.session.userId
            });
        }

    } catch (err) {
        console.log('err in getUserById in GET /user/id: ', err);
        res.json({ error: true });
    }

});




// default: show three most resent users
app.get('/find-users', async (req, res) => {
    // get three most resent users (id, first, last, img_url)
    try {
        const { rows } = await db.getNewUsers(req.session.userId);
        res.json(rows);

    } catch (err) {
        console.log('err in getNewUsers: ', err);
    }

});

// show the users usign user search input
app.get('/find-users/:input', async (req, res) => {

    try {
        const { rows } = await db.getMatchingUsers(req.params.input, req.session.userId);
        res.json(rows);

    } catch (err) {
        console.log('err in getMatchingUsers: ', err);
    }

});

app.get("/initial-friendship-status/:currProfileId", async (req, res) => {
    try {
        const { rows } = await db.checkFriendshipStatus(req.params.currProfileId, req.session.userId);
        // if the is no relationships between the recipient and the sender of the
        // friendship request make possible for the logged in user to send a reqest
        if (rows.length == 0) {
            res.json({ buttonText: 'send friend request' });

        } else {
            // if the is some relationship => check if the request was accepted:
            // yes => make it possible for the logged in user to end the friendship
            if (rows[0].accepted) {
                res.json({ buttonText: "end friendship" });

            } else {
                // if the recipient is NOT the logged in user => make is possible
                // for the logged in user to cancel the request she sent to the recipient
                if (rows[0].recipient_id == req.params.currProfileId) {
                    res.json({ buttonText: "cancel friend request" });
                } else {
                    // if the recipient is the logged in user => make it possible
                    // for her to accept the friendship request
                    res.json({ buttonText: "accept friend request" });
                }
            }
        }

    } catch (err) {
        console.log("err in checkFriendshipStatus GET /initial-friendship-status:", err);
    }
});

app.post("/send-friend-request/:currProfileId", async (req, res) => {
    try {
        await db.addFriendship(req.params.currProfileId, req.session.userId);
        res.json({ buttonText: 'cancel friend request' });

    } catch (err) {
        console.log('err in addFriendship: ', err);
    }

});

app.post("/end-friendship/:currProfileId", async (req, res) => {
    try {
        await db.deleteFriendship(req.params.currProfileId, req.session.userId);
        res.json({ buttonText: 'send friend request' });

    } catch (err) {
        console.log('err in deleteFriendship: ', err);
    }

});

app.post("/accept-friend-request/:currProfileId", async (req, res) => {
    try {
        await db.acceptFriendship(req.session.userId, req.params.currProfileId);
        res.json({ buttonText: 'end friendship' });

    } catch (err) {
        console.log('err in acceptFriendship: ', err);
    }
});

app.get("/wannabes-friends", async (req, res) => {
    try {
        const { rows } = await db.getFriendsWannabes(req.session.userId);
        res.json(rows);
    } catch (err) {
        console.log('err in getFriendsWannabes', err);
    }
});

app.post('/logout', (req, res) => {
    req.session.userId = null;
    res.json({ loggedout: true });
});

app.post('/delete-profile', async (req, res) => {
    const userId = req.session.userId;
    req.session.userId = null;
    console.log('userId: ', userId);

    // s3.delete(userId.toString());

    try {
        await db.deleteProfile(userId);
        res.json({ userId });

    } catch (err) {
        console.log('err in deleteProfile: ', err);
    }

});

///////////////// REQUESTS FOR FRIENDS OF FRIENS COMPONENT ////////////////
app.get("/friendship-status/:id", async (req, res) => {
    try {
        const { rows } = await db.checkFriendshipStatus(
            req.params.id,
            req.session.userId
        );
        // console.log("ROWS IN checkFriendshipStatus: ", rows);
        res.json(rows[0]);
    } catch (err) {
        console.log("err in checkFriendshipStatus: ", err);
    }
});

app.get('/friends-of-friend/:profileId', async (req, res) => {
    try {
        // the id of the currently viewed profile is passed to the function to
        // get the list of friends of the owner of the profile
        const { rows } = await db.findFriendshipsById(req.params.profileId);
        console.log('ROWS in findFriendshipsById: ', rows);
        res.json(rows);

    } catch(err) {
        console.log('err in findFriendshipsById: ', err);
    }

});

////////////////// DO NOT DELETE CODE BELOW THIS LINE //////////////////
app.get('*', function(req, res) {
    if (!req.session.userId) {
        res.redirect('/welcome');
    } else {
        res.sendFile(__dirname + '/index.html');
    }
});
////////////////// DO NOT DELETE CODE ABOVE THIS LINE //////////////////

server.listen(8080, function() {
    console.log("index.js for social network is listening 🦜");
});


let onlineUsers = {};
let ids = Object.values(onlineUsers);

io.on('connection', async (socket) => {
    console.log("the following socked.id is connected: ", socket.id);
    const userId = socket.request.session.userId;
    // socket gets access to cookies like this:
    if(!userId) {
        return socket.disconnect(true);
    }

    /////////////////////////////// PUBLIC CHAT ///////////////////////////////
    // place for getting the last ten chat messages
    try {
        const { rows } = await db.getLastTenMessages();
        // console.log("rows in getLastTenMessages: ", rows);
        io.sockets.emit('chatMessages', rows.reverse());

        //add new message to the chat
        socket.on('new message typed', async newMsg => {
            // console.log('newMsg', newMsg);
            // console.log('user who sent newMsg: ', userId);

            const { rows: userInfo } = await db.getUserInfo(userId);
            const { rows:messageInfo } = await db.addChatMessage(userId, newMsg);
            // merge user information and message information
            const newChatMsg = { ...userInfo[0], ...messageInfo[0] };

            // console.log('newChatMsg: ', newChatMsg);

            io.sockets.emit('addChatMsg', newChatMsg);
        });

    } catch (err) {
        console.log('err in getLastTenMessages: ', err);
    }


    ////////////////////////////////// SHOWING ONLINE USERS /////////////////////////////////////
    let idsBeforeNewUser = Object.values(onlineUsers); // onlineUsers obj is declared outside of the socket in order to keep track of the joining users
    // console.log('ids: ', ids);
    // add the user who just connected to the socket (logged it)
    onlineUsers[socket.id] = userId;
    // console.log('onlineUSers: ', onlineUsers);
    let allOnlineIds = Object.values(onlineUsers);

    // check if the newly logged in user's id is already in onlineUsers
    // ADD NEW ONLINE USER
    if (!idsBeforeNewUser.includes(userId)) {
        // add a new user to the array of all users online
        try {
            const { rows } = await db.getUserById(userId);
            // console.log('rows of the newly logged in user: ', rows[0]); 
            io.sockets.sockets[socket.id].broadcast.emit('userJoined', rows);

        } catch (err) {
            console.log('err in getUserById in socket: ', err);
        }

    } // closes else statement

    // DISPLAY ALL ONLINE USERS
    try {  
        const { rows } = await db.getUsersByIds(allOnlineIds);
        // console.log('ROWS: ', rows);
        // fire event only for the newly connected user
        io.sockets.sockets[socket.id].emit('allUsersOnline', rows);

    } catch (err) {
        console.log('err in getUsersById: ', err);
    }

    socket.on("disconnect", () => {
        delete onlineUsers[socket.id];

        let userIdArr = Object.values(onlineUsers).filter((id) => id == userId);

        if (userIdArr.length == 0) {
            io.sockets.emit("userLeft", userId);
        }

    });

});