const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer'); 
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const cors = require('cors')({origin: true}); // <-- CORS FIX 1: Import and configure cors

admin.initializeApp({
    projectId: 'syndeya-81bf4', 
});
const db = admin.firestore();

const mailTransport = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
    },
});

const EmailTemplate = {
    subject: (eventName) => `Great Connecting with you at ${eventName} | via Syndeya`,
    body: (contactName, eventName, ownerName) => `Hi ${contactName},

It was truly great meeting you and discussing [TOPIC_HERE] at the ${eventName}.

I wanted to quickly send over my information and look forward to staying in touch.

Best,
${ownerName}
--
Syndeya: The Synergy of Digital Connection`,
};

async function sendThankYou(recipientEmail, contactName, eventName, ownerName) {
    if (!recipientEmail || !process.env.MAIL_USER) {
        console.log("Recipient email or sender config missing. Skipping immediate follow-up.");
        return;
    }

    const mailOptions = {
        from: `Syndeya | ${ownerName} <${process.env.MAIL_USER}>`,
        to: recipientEmail,
        subject: EmailTemplate.subject(eventName),
        text: EmailTemplate.body(contactName, eventName, ownerName),
    };

    try {
        await mailTransport.sendMail(mailOptions);
        console.log(`Successfully sent thank you email to ${recipientEmail}`);
    } catch (error) {
        console.error(`Error sending email to ${recipientEmail}:`, error);
    }
}


// -------------------------------------------------------------------------
// FUNCTION 1: createContact (V2 HTTP POST)
// -------------------------------------------------------------------------
exports.createContact = onRequest({ region: "us-central1" }, (req, res) => {
    // <-- CORS FIX 2: Wrap the function in the cors handler
    cors(req, res, async () => {
        if (req.method !== 'POST' || !req.body.recipientEmail || !req.body.cardHolderId || !req.body.ownerName) {
            return res.status(400).send('Invalid request or missing required fields (email, ownerId, ownerName).');
        }

        const { recipientEmail, cardHolderId, ownerName, meetingLocation, targetName } = req.body;

        const timestampCreated = admin.firestore.Timestamp.now();
        const contactId = db.collection('contacts').doc().id; 
        const eventName = meetingLocation || 'a recent event';
        const contactName = targetName || 'New Contact';

        const newContact = {
            contact_id: contactId,
            owner_id: cardHolderId, 
            target_name: contactName,
            target_email: recipientEmail, 
            meeting_location: eventName,
            date_met: timestampCreated,
            notes: null,
            notes_prompted: false, 
            follow_up_time: null, 
            reminder_status: 'PENDING_NOTES', 
        };

        try {
            await db.collection('contacts').doc(contactId).set(newContact);
            sendThankYou(recipientEmail, contactName, eventName, ownerName); 

            return res.status(200).send({ 
                status: 'Success', 
                message: 'Contact logged and thank-you email triggered.',
                contactId: contactId
            });

        } catch (error) {
            console.error("Error creating contact:", error);
            return res.status(500).send("Server error during contact creation.");
        }
    });
});


// -------------------------------------------------------------------------
// FUNCTION 2: updateContactNotes (V2 HTTP POST)
// -------------------------------------------------------------------------
exports.updateContactNotes = onRequest({ region: "us-central1" }, (req, res) => {
    // <-- CORS FIX 3: Wrap the function in the cors handler
    cors(req, res, async () => {
        if (req.method !== 'POST' || !req.body.contactId || !req.body.notes) {
            return res.status(400).send('Invalid request or missing Contact ID or Notes.');
        }

        const { contactId, targetName, targetCompany, notes } = req.body;

        const followupIntervalHours = 720; // 30 days default
        const reminderTime = new Date(Date.now() + (followupIntervalHours * 60 * 60 * 1000));

        try {
            const contactRef = db.collection('contacts').doc(contactId);

            await contactRef.update({
                target_name: targetName,
                target_company: targetCompany,
                notes: notes,
                followup_interval_hours: followupIntervalHours,
                follow_up_time: admin.firestore.Timestamp.fromDate(reminderTime),

                notes_prompted: true, 
                reminder_status: 'PENDING',
            });

            return res.status(200).send({ 
                status: 'Success', 
                message: 'Details saved, final follow-up reminder scheduled.',
                reminderTime: reminderTime.toISOString()
            });

        } catch (error) {
            console.error(`Error updating contact ${contactId}:`, error);
            return res.status(500).send("Server error saving contact details.");
        }
    });
});


// -------------------------------------------------------------------------
// FUNCTION 3: processFollowUp (V2 Scheduled)
// -------------------------------------------------------------------------
exports.processFollowUp = onSchedule("0,6,12,18 * * * *", async (context) => {
    const currentTime = admin.firestore.Timestamp.now();
    const updatePromises = [];

    const twelveHoursAgo = new Date(currentTime.toDate().getTime() - (12 * 60 * 60 * 1000));

    const pendingNotesSnapshot = await db.collection('contacts')
        .where('notes_prompted', '==', false) 
        .where('date_met', '<=', admin.firestore.Timestamp.fromDate(twelveHoursAgo))
        .limit(50) 
        .get();

    pendingNotesSnapshot.forEach(doc => {
        const log = doc.data();
        console.log(`[PROMPT] Sending 'Add Notes' alert to owner ${log.owner_id} for contact ${log.target_name}.`);
        updatePromises.push(doc.ref.update({ notes_prompted: true })); 
    });

    const finalReminderSnapshot = await db.collection('contacts')
        .where('reminder_status', '==', 'PENDING')
        .where('follow_up_time', '<=', currentTime)
        .limit(50) 
        .get();

    finalReminderSnapshot.forEach(doc => {
        const log = doc.data();
        console.log(`[SUBSCRIPTION] Alerting owner ${log.owner_id} to follow up with ${log.target_name}. Notes: ${log.notes}.`);

        const ninetyDays = 90 * 24 * 60 * 60 * 1000;
        const newFollowUpTime = new Date(Date.now() + ninetyDays);

        updatePromises.push(doc.ref.update({ 
            reminder_status: 'SENT',
            follow_up_time: admin.firestore.Timestamp.fromDate(newFollowUpTime) 
        }));
    });

    await Promise.all(updatePromises);
    console.log(`Syndeya Scheduler Run Complete. Processed ${pendingNotesSnapshot.size} note prompts and ${finalReminderSnapshot.size} follow-up reminders.`);
    return null;
});
