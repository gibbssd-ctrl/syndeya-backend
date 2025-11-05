const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer'); 
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const cors = require('cors')({origin: true}); 

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

    // --- LOGIC 1: REMIND APP OWNER TO ADD NOTES (12 hours after meeting) ---
    const twelveHoursAgo = new Date(currentTime.toDate().getTime() - (12 * 60 * 60 * 1000));
    
    const pendingNotesSnapshot = await db.collection('contacts')
        .where('notes_prompted', '==', false) 
        .where('date_met', '<=', admin.firestore.Timestamp.fromDate(twelveHoursAgo))
        .limit(50) 
        .get();

    for (const doc of pendingNotesSnapshot.docs) {
        const log = doc.data();
        console.log(`[PROMPT] Processing 'Add Notes' for owner ${log.owner_id} for contact ${log.target_name}.`);
        
        try {
            // Get the user's auth record to find their email
            const userRecord = await admin.auth().getUser(log.owner_id);
            const ownerEmail = userRecord.email;
            const ownerName = userRecord.displayName || 'Syndeya User';

            if (ownerEmail) {
                // Send a real email reminder
                const mailOptions = {
                    from: `Syndeya Reminders <${process.env.MAIL_USER}>`,
                    to: ownerEmail,
                    subject: `Reminder: Add notes for ${log.target_name}`,
                    text: `Hi ${ownerName},\n\nThis is a reminder to add your notes for ${log.target_name}, whom you met at ${log.meeting_location}.\n\n- The Syndeya Team`
                };
                await mailTransport.sendMail(mailOptions);
                console.log(`Sent 'Add Notes' email to ${ownerEmail}`);
            }
            
            // Mark as prompted
            updatePromises.push(doc.ref.update({ notes_prompted: true }));

        } catch (error) {
            console.error(`Error processing note prompt for user ${log.owner_id}:`, error);
            // If the user was deleted or something went wrong, still mark as prompted
            // to avoid an infinite error loop.
            updatePromises.push(doc.ref.update({ notes_prompted: true, reminder_status: 'ERROR' }));
        }
    }

    // --- LOGIC 2: SUBSCRIPTION FOLLOW-UP REMINDER (30 Days After Notes Saved) ---
    const finalReminderSnapshot = await db.collection('contacts')
        .where('reminder_status', '==', 'PENDING')
        .where('follow_up_time', '<=', currentTime)
        .limit(50) 
        .get();
        
    for (const doc of finalReminderSnapshot.docs) {
        const log = doc.data();
        console.log(`[SUBSCRIPTION] Processing follow-up for owner ${log.owner_id} for contact ${log.target_name}.`);

        try {
            // Get the user's auth record to find their email
            const userRecord = await admin.auth().getUser(log.owner_id);
            const ownerEmail = userRecord.email;
            const ownerName = userRecord.displayName || 'Syndeya User';

            if (ownerEmail) {
                // Send the 30-day follow-up email
                const mailOptions = {
                    from: `Syndeya Reminders <${process.env.MAIL_USER}>`,
                    to: ownerEmail,
                    subject: `Time to follow up with ${log.target_name}!`,
                    text: `Hi ${ownerName},\n\nThis is your scheduled 30-day reminder to follow up with ${log.target_name}.\n\nYour notes: ${log.notes}\n\n- The Syndeya Team`
                };
                await mailTransport.sendMail(mailOptions);
                console.log(`Sent 30-day follow-up to ${ownerEmail}`);
            }
            
            // Schedule the next 90-day reminder
            const ninetyDays = 90 * 24 * 60 * 60 * 1000;
            const newFollowUpTime = new Date(Date.now() + ninetyDays);
            
            updatePromises.push(doc.ref.update({ 
                reminder_status: 'SENT',
                follow_up_time: admin.firestore.Timestamp.fromDate(newFollowUpTime) 
            }));

        } catch (error) {
            console.error(`Error processing 30-day follow-up for user ${log.owner_id}:`, error);
            // If something went wrong, set status to ERROR to avoid spamming
            updatePromises.push(doc.ref.update({ reminder_status: 'ERROR' }));
        }
    }

    await Promise.all(updatePromises);
    console.log(`Syndeya Scheduler Run Complete. Processed ${pendingNotesSnapshot.size} note prompts and ${finalReminderSnapshot.size} follow-up reminders.`);
    return null;
});
