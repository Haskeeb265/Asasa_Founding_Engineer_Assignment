- My understanding of this assignment is that I'm to create a dummy user dashboard where the user can trade (buy and sell) gold with his balance. Talking about balance, there are 3 balances in this assignment:
    1. First balance is the PKR balance of the user
    2. Second is the GOLD balance of the user
    3. Third is the platform balance (of ASASA). This balance is basically the Gold Asasa owns which it can provide to it's users for trading.

- The flow that I understood from the doc is this:
    Initially the user would be on his dashboard where he can observe his PKR and Gold balance as well ---> The user will now select if he wants to BUY or SELL ---> The user will then enter the respective amount (in case of buying, PKR. in case of selling, Gold) ---> Now the user will be shown a quote with a 75 sec timer.There will be a summary of the trade the user just created. It will show them the price on which they're buying or selling, how much they're buying or selling, their balances post trade (details are added on my assumptions since there's no specifications regarding it in the doc ) ---> If the user either cancels the trade or let the 75 sec counter run out, the trade will not take place and the user will be promptly notified. However if the user confirms the trade within the lock window, the trade will take place ---> Once the trade takes place, all 3 balances would update and a reciept of the trade will be provided to the user.

- Regarding the sources, we have in total 2 sources which are PakGold.pk and  GoldPrice.org. Both of these sources doesn't provide us with their API key so I dived in browser tools and found the endpoints from where these sources were getting the gold rates. PakGold fetches the USD gold value and then calculates the PKR value on client end using conversion rates. Which means that PakGold gets it's value using 2 endpoints. Whereas GoldPrice.org returns us the direct gold value in PKR. 

- Another open ended detail that i noticed is the guardrail value. There's no value for the guardrail provided in the BUYING formula. I have 3 options: one is to set it as a constant value, second is to let the tester(evaluator) of my assignment enter the guardrail value, third is to calculate the guardrail value myself. I want to go with the third option but that might fall into goldplating and the more straight forward + efficient solution for our usecase (test the transactional flow) is to let the evaluator enter the guardrail value.

- As for the UI, I looked at Asasa's official website. However instead of copying the design as it is, I'll use it as an inspo while keeping the overall theme coherrent with the company image. 

- Regarding source validation, i've decided to use a third source. My logic regarding data valdiation is that within each interval where we'll fetch the price (5 mins), I'll fetch the price from all 3 sources and calculate the divergence between them. If the divergence is in 0.n%s then we can attribute that differnce to cadence. However if there's a larger difference then we cna conclude that the data is unreliable. This also covers one of the 4 stress cases provided in the doc


MISC
- Goldprice.org's plain GET request was returning 403. However using curl_cffi, it started returning 200.
